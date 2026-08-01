/**
 * The deterministic solution composer (plan 43 Phase 5, "Implement the deterministic solution composer").
 *
 * Takes retrieval's three lanes and assembles up to three routes — human, AI, hybrid — each of which either
 * states how it would do the work or states why it cannot. No model is called: every decision here is a set
 * cover, a graph check, an arithmetic interval, or a constraint comparison, and all of them are readable.
 *
 * That is the point of "deterministic". A recommendation records the component versions and evidence it cited
 * so it can be audited later, and an audit is only meaningful if the same inputs produce the same routes. A
 * composer that asked a model to arrange the candidates would produce advice nobody could reconstruct.
 *
 * ## What decides a route's status
 *
 * - `unavailable` — a hard constraint is definitely violated, the graph forbids the combination, or there is
 *   nothing to build with. Always carries a reason.
 * - `available` — offerable, but something could not be checked: an unknown budget, an unpriceable route, a
 *   coverage gap delegated to a person.
 * - `recommended` — every mandatory capability covered or explicitly delegated, no violated constraint, and
 *   nothing left unverifiable.
 *
 * The middle state is what keeps this honest. Without it, every route with an unknown would have to be either
 * suppressed (hiding real options) or recommended (claiming a check nobody performed).
 */
import { createHash } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '~/shared/lib/db/client'
import { log } from '~/shared/lib/log'
import type { RouteType, SolutionBrief, SolutionRoute } from '~/shared/lib/solutions/contracts'
import { listTraversableEdges } from '~/shared/lib/repositories/solution-catalog'
import { findMarketRateBand, MARKET_RATE_SOURCE_KEYS, type MarketRateBand } from '~/lib/solutions/retrieval/market-rates'
import type { RetrievalResult } from '~/lib/solutions/retrieval/retrieve'
import type { HumanCandidate } from '~/lib/solutions/retrieval/lanes'
import { checkCompatibility, coverCapabilities, humanReviewPoints, type CoverageAssignment, type CoverageCandidate } from './coverage'
import { checkConstraints, unknownHardFields, type RouteFacts } from './constraints'
import { estimateRoute, timeOnlyEstimate, type RouteEstimate } from './estimate'

/** Bumped when the composition rules change, so a stored run says which rules produced it. */
export const COMPOSER_VERSION = 'composer-1'

export interface ComposeInput {
  brief: SolutionBrief
  retrieval: RetrievalResult
  /** Real people, from `humanLane`. Empty is a normal state and produces an unavailable human route. */
  people: readonly HumanCandidate[]
  db?: PostgresJsDatabase
  now?: Date
}

export interface RouteTrace {
  routeType: RouteType
  candidatesConsidered: number
  assignmentCount: number
  coverageGaps: string[]
  violatedConstraints: string[]
  unverifiableConstraints: string[]
  incompatiblePairs: number
  cycles: number
  status: SolutionRoute['status']
}

export interface ComposeResult {
  routes: SolutionRoute[]
  /** Component versions every route cited, for the run record. */
  componentVersionIds: string[]
  warnings: string[]
  trace: {
    composerVersion: string
    retrievalQueryHash: string
    /** Stable over identical (brief, candidate set) so two runs can be compared. */
    compositionHash: string
    marketRateSampleSize: number | null
    routes: RouteTrace[]
    durationMs: number
  }
}

export async function composeRoutes(input: ComposeInput): Promise<ComposeResult> {
  const db = input.db ?? publicDb
  const started = Date.now()
  const warnings: string[] = []

  // One market-rate lookup, reused by every route that needs a price. The band describes the *work*, not the
  // route, so looking it up per route would issue the same query three times.
  const marketRate = await loadMarketRate(input.brief, db)
  if (!marketRate) {
    warnings.push('No advertised-salary band for this kind of work: routes with people are not priced')
  }

  const routes: SolutionRoute[] = []
  const traces: RouteTrace[] = []
  const citedVersions = new Set<string>()

  for (const routeType of ['human', 'ai', 'hybrid'] as const) {
    const candidates = candidatesFor(routeType, input)
    const built = await buildRoute(routeType, candidates, input, marketRate, db)
    routes.push(built.route)
    traces.push(built.trace)
    for (const version of built.citedVersions) citedVersions.add(version)
  }

  const result: ComposeResult = {
    routes,
    componentVersionIds: [...citedVersions].sort(),
    warnings,
    trace: {
      composerVersion: COMPOSER_VERSION,
      retrievalQueryHash: input.retrieval.trace.queryHash,
      compositionHash: hashComposition(input, routes),
      marketRateSampleSize: marketRate?.sampleSize ?? null,
      routes: traces,
      durationMs: Date.now() - started,
    },
  }

  log.info('solutions_composed', {
    retrievalQueryHash: result.trace.retrievalQueryHash,
    statuses: routes.map((route) => `${route.routeType}:${route.status}`),
    durationMs: result.trace.durationMs,
  })
  return result
}

/**
 * Which candidates a route may draw on.
 *
 * The human route uses real people from `canonical_humans`, not the `human_role` components the job feeds
 * produce. A job posting says an employer wants a role filled; it is not someone who can do the work, and
 * offering one as a candidate would be the composer's most misleading possible output.
 *
 * The hybrid route draws on all three lanes, which is what makes it hybrid: it is allowed to pair a person
 * with a model, and the coverage pass decides whether that actually helps.
 */
function candidatesFor(routeType: RouteType, input: ComposeInput): CoverageCandidate[] {
  const asPerson = (person: HumanCandidate): CoverageCandidate => ({
    // Prefixed, because a canonical human id and a component id are different id spaces and a route
    // assignment carries only one field. The prefix is the discriminator, and it also means a UI can tell a
    // person from a catalog entry without a second lookup.
    componentId: person.canonicalHumanId ? `human:${person.canonicalHumanId}` : `account:${person.builderIdentityId}`,
    componentVersion: 1,
    displayName: person.displayName ?? person.username,
    kind: 'human_profile',
    /**
     * **Empty, deliberately.** Nothing in this product asks a person what they can do, and nothing verifies
     * it — retrieval matched them on what their public activity is *about*. Claiming a capability on their
     * behalf would be the composer inventing the one thing it has no evidence for.
     *
     * An earlier version treated a person as covering every requested capability, and the consequence was
     * immediate and visible in a real run: a person always won the set cover, so the hybrid route came back
     * identical to the human route and the AI lane never contributed anything. A person covers work by
     * *delegation*, which `humanReviewPoints` states explicitly and the contract's own refinement accepts as
     * grounds for recommending an incompletely-covered route.
     */
    capabilityKeys: [],
    maxEvidenceLevel: 'claimed',
    score: person.followersCount,
    homepageUrl: person.profileUrl,
  })

  const fromLane = (lane: 'ai' | 'tooling'): CoverageCandidate[] =>
    input.retrieval.byLane[lane].map((candidate) => ({
      componentId: candidate.componentId,
      componentVersion: candidate.version,
      displayName: candidate.displayName,
      kind: candidate.kind,
      capabilityKeys: candidate.capabilityKeys,
      maxEvidenceLevel: candidate.maxEvidenceLevel,
      score: candidate.finalScore,
      homepageUrl: null,
    }))

  switch (routeType) {
    case 'human':
      return input.people.map(asPerson)
    case 'ai':
      return [...fromLane('ai'), ...fromLane('tooling')]
    case 'hybrid':
      return [...input.people.slice(0, 2).map(asPerson), ...fromLane('ai'), ...fromLane('tooling')]
  }
}

async function buildRoute(
  routeType: RouteType,
  candidates: readonly CoverageCandidate[],
  input: ComposeInput,
  marketRate: MarketRateBand | null,
  db: PostgresJsDatabase,
): Promise<{ route: SolutionRoute; trace: RouteTrace; citedVersions: string[] }> {
  const baseTrace: RouteTrace = {
    routeType,
    candidatesConsidered: candidates.length,
    assignmentCount: 0,
    coverageGaps: [],
    violatedConstraints: [],
    unverifiableConstraints: [],
    incompatiblePairs: 0,
    cycles: 0,
    status: 'unavailable',
  }

  if (candidates.length === 0) {
    return {
      route: unavailable(routeType, routeType === 'human'
        ? 'No person in the index matches this brief. Identity unification needs deterministic evidence, so most accounts are not yet linked to a person.'
        : 'No catalog component claims the capabilities this brief asks for.'),
      trace: baseTrace,
      citedVersions: [],
    }
  }

  /**
   * The human route is assembled rather than set-covered.
   *
   * Set cover needs candidates that claim capabilities, and people claim none. So the best people are taken
   * directly and every capability becomes a gap the review points delegate — which is the truthful shape: a
   * person is being asked to do the work, not verified as able to.
   */
  const coverage = routeType === 'human'
    ? delegateToPeople(input.brief.capabilities, candidates)
    : coverCapabilities(input.brief.capabilities, candidates)

  /**
   * A hybrid route must contain a person, or it is not hybrid.
   *
   * Component coverage alone produced a "hybrid" route identical to the AI route, whose own review points then
   * said *"sign off before delivery — this route has no person in it"*. A route that has to tell the user
   * nobody is in it is not a hybrid; it is the AI route wearing a different label.
   *
   * So the best person is appended as the named reviewer. When components left gaps they take those too;
   * when components covered everything, review is the job — and naming who does it is the difference between a
   * plan and an instruction.
   */
  if (routeType === 'hybrid') {
    const person = candidates.find((candidate) => candidate.kind === 'human_profile'
      && !coverage.assignments.some((assignment) => assignment.componentId === candidate.componentId))
    if (!person) {
      return {
        route: unavailable('hybrid', 'A hybrid route needs a person, and no person in the index matches this brief.'),
        trace: { ...baseTrace, assignmentCount: coverage.assignments.length, coverageGaps: coverage.gaps },
        citedVersions: [],
      }
    }
    coverage.assignments.push({
      componentId: person.componentId,
      componentVersion: person.componentVersion,
      displayName: person.displayName,
      kind: person.kind,
      coveredCapabilityKeys: coverage.gaps.length > 0 ? [...coverage.gaps].sort() : [...input.brief.capabilities].sort(),
      evidenceLevel: person.maxEvidenceLevel,
      homepageUrl: person.homepageUrl ?? null,
    })
    // The gaps are now delegated to a named person rather than left open.
    coverage.gaps = []
  }

  if (coverage.assignments.length === 0) {
    return {
      route: unavailable(routeType, 'No candidate claims any capability this brief asks for.'),
      trace: { ...baseTrace, coverageGaps: coverage.gaps },
      citedVersions: [],
    }
  }

  // Only real catalog components have edges; a person's id is not in the graph. Loaded per assignment because
  // `listTraversableEdges` is keyed by one component, and it filters to active edges in SQL so a proposed
  // combination cannot reach a recommendation.
  const catalogIds = coverage.assignments
    .filter((assignment) => !assignment.componentId.startsWith('human:') && !assignment.componentId.startsWith('account:'))
    .map((assignment) => assignment.componentId)
  const edges = (await Promise.all(catalogIds.map((id) => listTraversableEdges(id, undefined, db)))).flat()
    .map((edge) => ({ edgeType: edge.edgeType, fromComponentId: catalogIds[0], toComponentId: edge.toComponentId }))

  const compatibility = checkCompatibility(coverage.assignments.map((a) => a.componentId), edges)
  if (compatibility.incompatiblePairs.length > 0) {
    const pair = compatibility.incompatiblePairs[0]
    return {
      route: unavailable(routeType, `The catalog records ${pair.from} and ${pair.to} as incompatible.`),
      trace: { ...baseTrace, assignmentCount: coverage.assignments.length, incompatiblePairs: compatibility.incompatiblePairs.length },
      citedVersions: [],
    }
  }
  if (compatibility.cycles.length > 0) {
    return {
      route: unavailable(routeType, `These components require each other in a cycle (${compatibility.cycles[0].join(' → ')}), so no order of work exists.`),
      trace: { ...baseTrace, assignmentCount: coverage.assignments.length, cycles: compatibility.cycles.length },
      citedVersions: [],
    }
  }

  const reviewPoints = humanReviewPoints(coverage.assignments, coverage.gaps)
  const componentKinds = coverage.assignments.map((assignment) => assignment.kind)
  const estimate: RouteEstimate | null =
    estimateRoute({ brief: input.brief, marketRate, componentKinds }) ?? timeOnlyEstimate({ brief: input.brief, marketRate, componentKinds })

  const facts: RouteFacts = {
    coveredCapabilityKeys: coverage.assignments.flatMap((assignment) => assignment.coveredCapabilityKeys),
    componentIds: coverage.assignments.map((assignment) => assignment.componentId),
    // Nothing in the catalog populates integrations or regulated domains yet. Empty is the truthful value, and
    // `checkConstraints` treats an empty integration list as unverifiable rather than as a violation.
    integrationKeys: [],
    domains: [],
    costCents: estimate.costMaxCents > 0
      ? { min: estimate.costMinCents, max: estimate.costMaxCents, currency: estimate.currency }
      : null,
    timeHours: { min: estimate.timeMinHours, max: estimate.timeMaxHours },
    maxDataSensitivity: null,
  }

  const constraintOutcomes = checkConstraints(input.brief, facts)
  const violated = constraintOutcomes.filter((outcome) => outcome.kind === 'violated')
  const unverifiable = [...constraintOutcomes.filter((outcome) => outcome.kind === 'unverifiable')]

  /**
   * A stated budget is a limit even when it is not a hard constraint.
   *
   * `brief.budget` and a `max_budget` hard constraint are different things — the first is what the user has,
   * the second is a line they will not cross — and `checkConstraints` only sees the second. A real run
   * exposed the gap: a route whose cost could not be estimated came back `recommended` while the brief
   * carried a budget, which presents an unpriced route as vetted against a figure nobody compared it to.
   */
  if (input.brief.budget?.status === 'known' && !facts.costCents) {
    unverifiable.push({
      kind: 'unverifiable',
      constraintType: 'stated_budget',
      reason: `The brief states a budget of ${(input.brief.budget.value.maxCents / 100).toFixed(2)} ${input.brief.budget.value.currency}, and this route could not be priced`,
    })
  } else if (input.brief.budget?.status === 'known' && facts.costCents) {
    const budget = input.brief.budget.value
    if (facts.costCents.currency === budget.currency && facts.costCents.max > budget.maxCents) {
      unverifiable.push({
        kind: 'unverifiable',
        constraintType: 'stated_budget',
        reason: `Upper estimate ${(facts.costCents.max / 100).toFixed(2)} ${budget.currency} may exceed the stated budget of ${(budget.maxCents / 100).toFixed(2)} ${budget.currency}`,
      })
    }
  }

  if (violated.length > 0) {
    return {
      route: unavailable(routeType, violated.map((outcome) => outcome.reason).join('; ')),
      trace: {
        ...baseTrace,
        assignmentCount: coverage.assignments.length,
        coverageGaps: coverage.gaps,
        violatedConstraints: violated.map((outcome) => outcome.constraintType),
      },
      citedVersions: [],
    }
  }

  const unknowns = unknownHardFields(input.brief)
  const limitations = [
    ...unverifiable.map((outcome) => outcome.reason),
    ...unknowns.map((field) => `The brief left ${field} unknown, so this route was not checked against it`),
    ...compatibility.missingRequirements.map((missing) => `${missing.componentId} requires ${missing.requires}, which this route does not include`),
  ]

  /**
   * `recommended` needs three things, and the third is the one worth stating.
   *
   * Coverage may be incomplete *provided* a named review point takes the gap — that is the contract's own
   * refinement, and it is what lets a route that needs a person for one step still be the best answer. But
   * nothing unverifiable may remain: a route offered as recommended has been checked, and an unknown budget
   * means it has not.
   */
  const coveredOrDelegated = coverage.complete || reviewPoints.length > 0
  const status: SolutionRoute['status'] = coveredOrDelegated && limitations.length === 0 ? 'recommended' : 'available'

  const route: SolutionRoute = {
    routeType,
    status,
    summary: summarize(routeType, coverage.assignments.map((a) => a.displayName)),
    fitExplanation: explainFit(routeType, coverage, unknowns, unverifiable.length),
    steps: buildSteps(coverage.assignments, reviewPoints),
    components: coverage.assignments.map((assignment) => ({
      componentId: assignment.componentId,
      componentVersion: assignment.componentVersion,
      role: `Covers ${assignment.coveredCapabilityKeys.map((key) => key.replace(/_/g, ' ')).join(', ')}`,
      coveredCapabilityKeys: assignment.coveredCapabilityKeys,
      ...(assignment.homepageUrl && assignment.homepageUrl.startsWith('https://') ? { link: assignment.homepageUrl } : {}),
    })),
    mandatoryCapabilitiesCovered: coverage.complete,
    coverageGapCapabilityKeys: coverage.gaps,
    limitations,
    estimate: {
      costMinCents: estimate.costMinCents,
      costMaxCents: estimate.costMaxCents,
      currency: estimate.currency,
      timeMinHours: estimate.timeMinHours,
      timeMaxHours: estimate.timeMaxHours,
      assumptions: estimate.assumptions.slice(0, 10),
    },
    risks: buildRisks(coverage, routeType),
    humanReviewPoints: reviewPoints,
    // The contract requires at least one evidence id. A route's evidence is the versions it cites — an
    // auditor can pull each one and see what the source said at the time.
    evidenceIds: coverage.assignments.map((assignment) => `${assignment.componentId}@${assignment.componentVersion}`),
  }

  return {
    route,
    trace: {
      ...baseTrace,
      assignmentCount: coverage.assignments.length,
      coverageGaps: coverage.gaps,
      unverifiableConstraints: unverifiable.map((outcome) => outcome.constraintType),
      status,
    },
    citedVersions: route.evidenceIds,
  }
}

/**
 * Assigns the best people and delegates the whole brief to them.
 *
 * At most two, because a route naming six people is not a plan — it is a list, and a recruiter reading it has
 * been given the search results back rather than a recommendation.
 */
function delegateToPeople(
  capabilities: readonly string[],
  candidates: readonly CoverageCandidate[],
): { assignments: CoverageAssignment[]; gaps: string[]; complete: boolean } {
  const chosen = [...candidates]
    // Deterministic: score, then id. Two people with identical scores must not swap places between runs.
    .sort((a, b) => (b.score - a.score) || (a.componentId < b.componentId ? -1 : 1))
    .slice(0, 2)

  return {
    assignments: chosen.map((candidate) => ({
      componentId: candidate.componentId,
      componentVersion: candidate.componentVersion,
      displayName: candidate.displayName,
      kind: candidate.kind,
      // What they are being asked to do, which is not the same as what they are known to do. The review points
      // and `mandatoryCapabilitiesCovered: false` are what keep that distinction visible.
      coveredCapabilityKeys: [...capabilities].sort(),
      evidenceLevel: candidate.maxEvidenceLevel,
      homepageUrl: candidate.homepageUrl ?? null,
    })),
    gaps: [...capabilities].sort(),
    complete: false,
  }
}

function unavailable(routeType: RouteType, reason: string): SolutionRoute {
  return {
    routeType,
    status: 'unavailable',
    unavailableReason: reason.slice(0, 300),
    summary: `No ${routeType} route is available for this brief`,
    fitExplanation: reason.slice(0, 2000),
    steps: ['No steps: this route is not available'],
    // The schema requires at least one component and one evidence id even for an unavailable route, so a
    // sentinel is used rather than leaving the shape invalid. It names the reason rather than pretending a
    // component was chosen.
    components: [{
      componentId: 'unavailable',
      componentVersion: 1,
      role: 'Placeholder for an unavailable route',
      coveredCapabilityKeys: ['none'],
    }],
    mandatoryCapabilitiesCovered: false,
    coverageGapCapabilityKeys: [],
    limitations: [reason.slice(0, 300)],
    risks: [],
    humanReviewPoints: [],
    evidenceIds: ['unavailable'],
  }
}

function summarize(routeType: RouteType, names: readonly string[]): string {
  const label = routeType === 'human' ? 'People' : routeType === 'ai' ? 'Automated' : 'People and automation'
  return `${label}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`.slice(0, 600)
}

function explainFit(
  routeType: RouteType,
  coverage: { assignments: readonly { displayName: string; coveredCapabilityKeys: string[] }[]; gaps: readonly string[]; complete: boolean },
  unknowns: readonly string[],
  unverifiableCount: number,
): string {
  const parts: string[] = []
  for (const assignment of coverage.assignments) {
    parts.push(`${assignment.displayName} covers ${assignment.coveredCapabilityKeys.map((key) => key.replace(/_/g, ' ')).join(' and ')}.`)
  }
  if (!coverage.complete) {
    parts.push(`Nothing in the catalog claims ${coverage.gaps.join(', ')}, so a person takes that part.`)
  }
  if (unknowns.length > 0) {
    parts.push(`The brief left ${unknowns.join(', ')} unknown, so this route was not checked against ${unknowns.length === 1 ? 'it' : 'them'}.`)
  }
  if (unverifiableCount > 0) {
    parts.push('Some constraints could not be verified from what the catalog records; see the limitations.')
  }
  if (routeType === 'human') {
    // The honest bound on a human route: relevance is what retrieval established, not ability.
    parts.push('People are matched on what their public activity is about, not on a verified capability — nothing in this product asks them what they can do.')
  }
  return parts.join(' ').slice(0, 2000)
}

function buildSteps(
  assignments: readonly { displayName: string; coveredCapabilityKeys: string[] }[],
  reviewPoints: readonly string[],
): string[] {
  const steps = assignments.map((assignment, index) =>
    `${index + 1}. ${assignment.displayName} handles ${assignment.coveredCapabilityKeys.map((key) => key.replace(/_/g, ' ')).join(' and ')}`.slice(0, 300),
  )
  for (const point of reviewPoints) steps.push(`${steps.length + 1}. ${point}`.slice(0, 300))
  return steps.length > 0 ? steps.slice(0, 30) : ['1. No steps could be derived']
}

function buildRisks(
  coverage: { assignments: readonly { evidenceLevel: string; displayName: string }[]; gaps: readonly string[] },
  routeType: RouteType,
): string[] {
  const risks: string[] = []
  const claimed = coverage.assignments.filter((assignment) => assignment.evidenceLevel === 'claimed').length
  if (claimed > 0) {
    risks.push(`${claimed} of ${coverage.assignments.length} components rest on the vendor's own capability claim, which nobody has verified`)
  }
  if (coverage.gaps.length > 0) {
    risks.push(`${coverage.gaps.join(', ')} has no component behind it and depends entirely on the person assigned`)
  }
  if (routeType === 'ai') {
    risks.push('No person is in this route by construction; correctness depends on the sign-off step')
  }
  return risks.slice(0, 10)
}

/**
 * Loads the advertised-salary band for the kind of work this brief describes.
 *
 * Queried with the deliverable's own words, so the band describes comparable roles rather than an average over
 * every posting. Returns null when fewer than the minimum number of comparable postings exist — and null then
 * propagates all the way to "this route is not priced", which is the truthful outcome.
 */
async function loadMarketRate(brief: SolutionBrief, db: PostgresJsDatabase): Promise<MarketRateBand | null> {
  const outcome = await findMarketRateBand({
    roleText: `${brief.deliverable.description} ${brief.capabilities.join(' ')}`,
    sourceKeys: MARKET_RATE_SOURCE_KEYS,
  }, db)
  return outcome.status === 'ok' ? outcome.band : null
}

/**
 * Identifies a composition by what determined it.
 *
 * The brief's retrieval-relevant fields, the constraints, and the component versions each route cited. Two
 * runs producing the same hash produced the same advice, which is what makes "this recommendation was
 * reproducible" a checkable statement rather than a hope.
 */
function hashComposition(input: ComposeInput, routes: readonly SolutionRoute[]): string {
  return createHash('sha256')
    .update(JSON.stringify({
      queryHash: input.retrieval.trace.queryHash,
      composerVersion: COMPOSER_VERSION,
      constraints: [...input.brief.hardConstraints].map((constraint) => JSON.stringify(constraint)).sort(),
      rankingMode: input.brief.rankingMode,
      routes: routes.map((route) => ({
        routeType: route.routeType,
        status: route.status,
        components: route.components.map((component) => `${component.componentId}@${component.componentVersion}`).sort(),
      })),
    }))
    .digest('hex')
}
