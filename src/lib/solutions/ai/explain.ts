/**
 * Grounded route explanation (plan 43 Phase 7, "Register grounded route explanation").
 *
 * Rewrites one already-composed route as prose, then checks the prose against the route before using it. The
 * checks are the deliverable, not the prose: a reader cannot tell which sentence of an explanation was grounded
 * and which was fluent, so the only useful guarantee is one enforced after the fact.
 *
 * ## What is checked, and why each one
 *
 * - **Citations resolve.** An evidence id nobody can pull is indistinguishable from an invention. Enforced by
 *   the task's own schema (`buildSolutionsExplainOutputSchema`) and re-checked here, because the schema is built
 *   from the ids the *caller* passed and this function is what decides what to pass.
 * - **No unsupported figures.** Any currency amount, percentage, or `Nx` multiple in the prose must appear in
 *   the estimate text the composer produced. This is the concrete form of "prohibit new price or performance
 *   claims": a model that writes "typically 40% faster" has invented a benchmark, and no amount of prompt
 *   instruction reliably stops it.
 * - **No new components.** Only names in the route may be presented as part of it. Checked by requiring every
 *   cited id to belong to the route and by rejecting prose that introduces a bracketed id that does not.
 * - **No compatibility claims.** The graph records those, and the graph was not supplied. A sentence asserting
 *   two components "integrate" is a claim about data this function deliberately withheld.
 *
 * ## Failing closed means the deterministic text, not an error
 *
 * The composer already produced a summary and a fit explanation, and they are true. So a failed check costs the
 * user prose quality and nothing else, which is why every failure path returns the deterministic text with a
 * reason attached rather than raising. A retry is deliberately not attempted: re-rolling an explanation until it
 * passes a groundedness check selects for explanations that pass the check, which is not the same as grounded.
 */
import { AIDisabledError, AIParseError } from '~/shared/lib/ai/errors'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import { SOLUTIONS_EXPLAIN_PROMPT_VERSION, getTask, isTaskDisabled } from '~/shared/lib/ai/tasks'
import { env } from '~/shared/lib/env'
import { log } from '~/shared/lib/log'
import { buildSolutionsExplainOutputSchema, type RouteEvidenceSnippet } from '~/shared/lib/solutions/ai-contracts'
import { getSolutionsFeatureFlags } from '~/shared/lib/solutions/config'
import type { SolutionRoute } from '~/shared/lib/solutions/contracts'

export const EXPLAIN_TASK_ID = 'solutions-route-explain'

export type ExplainProvenance = 'model' | 'deterministic'

export type ExplainFallbackReason =
  | 'ai_disabled'
  | 'explanation_flag_off'
  | 'route_unavailable'
  | 'provider_failed'
  | 'invalid_output'
  | 'unsupported_figure'
  | 'unknown_component_reference'
  | 'compatibility_claim'

export interface ExplainedRoute {
  summary: string
  fitExplanation: string
  provenance: ExplainProvenance
  /** Set only on the deterministic path. Recorded in the run trace so a reviewer can see how often this fires. */
  fallbackReason?: ExplainFallbackReason
  citedEvidenceIds: string[]
  promptVersion: string | null
}

export interface ExplainInput {
  route: SolutionRoute
  /** The catalog's own claims for this route's components. Only these may be cited. */
  evidence: readonly RouteEvidenceSnippet[]
  /** Injected in tests. Defaults to the real provider call. */
  complete?: (args: { system: string; prompt: string; maxOutputTokens: number }) => Promise<unknown>
}

export async function explainRoute(input: ExplainInput): Promise<ExplainedRoute> {
  const { route } = input

  /**
   * An unavailable route is not explained by a model.
   *
   * Its `fitExplanation` is the reason it cannot be offered — a hard constraint that is definitely violated, or
   * an empty candidate set — and that reason is already the clearest sentence available. Sending it to be
   * rewritten risks softening a refusal into something that reads like an option.
   */
  if (route.status === 'unavailable') return deterministic(route, 'route_unavailable')
  if (!getSolutionsFeatureFlags().explanationEnabled) return deterministic(route, 'explanation_flag_off')

  const task = getTask(EXPLAIN_TASK_ID)
  if (!task || isTaskDisabled(EXPLAIN_TASK_ID, env)) return deterministic(route, 'ai_disabled')

  const evidenceIds = route.evidenceIds
  const schema = buildSolutionsExplainOutputSchema(evidenceIds)
  const estimateText = formatEstimate(route)
  const prompt = task.buildPrompt({
    routeType: route.routeType,
    status: route.status,
    deterministicSummary: route.summary,
    components: route.components.map((component, index) => ({
      // The evidence id the route already cites, positionally aligned with `evidenceIds` as the composer built
      // them. Falls back to the component id so a mismatch cannot silently cite the wrong component.
      evidenceId: evidenceIds[index] ?? component.componentId,
      displayName: component.componentId,
      role: component.role,
      coveredCapabilityKeys: component.coveredCapabilityKeys,
    })),
    coverageGapCapabilityKeys: route.coverageGapCapabilityKeys,
    limitations: route.limitations,
    risks: route.risks,
    humanReviewPoints: route.humanReviewPoints,
    estimateText,
    evidence: input.evidence,
  })

  let raw: unknown
  try {
    raw = input.complete
      ? await input.complete({ system: task.system, prompt, maxOutputTokens: task.maxOutputTokens })
      : await minimaxChat({ system: task.system, prompt, schema, maxOutputTokens: task.maxOutputTokens })
  } catch (error) {
    const reason: ExplainFallbackReason = error instanceof AIDisabledError
      ? 'ai_disabled'
      : error instanceof AIParseError ? 'invalid_output' : 'provider_failed'
    log.warn('solutions_explain_fallback', { reason, routeType: route.routeType })
    return deterministic(route, reason)
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    log.warn('solutions_explain_invalid_output', {
      routeType: route.routeType,
      issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message),
    })
    return deterministic(route, 'invalid_output')
  }

  const prose = `${parsed.data.summary}\n${parsed.data.fitExplanation}`
  const violation = findGroundingViolation(prose, { estimateText, evidenceIds })
  if (violation) {
    log.warn('solutions_explain_ungrounded', { routeType: route.routeType, violation })
    return deterministic(route, violation)
  }

  return {
    summary: parsed.data.summary,
    fitExplanation: parsed.data.fitExplanation,
    provenance: 'model',
    citedEvidenceIds: parsed.data.citedEvidenceIds,
    promptVersion: SOLUTIONS_EXPLAIN_PROMPT_VERSION,
  }
}

/**
 * The groundedness checks, as a pure function so they can be tested against prose directly.
 *
 * Returns the first violation found. Order is deliberate: a figure claim is the most consequential, because a
 * user acts on a price or a speed, while a stray bracketed id is mostly confusing.
 */
export function findGroundingViolation(
  prose: string,
  context: { estimateText: string; evidenceIds: readonly string[] },
): ExplainFallbackReason | null {
  const allowed = allowedFigures(context.estimateText)

  for (const figure of extractFigures(prose)) {
    if (!allowed.has(figure)) return 'unsupported_figure'
  }

  for (const reference of prose.matchAll(/\[([^\]\s]+@\d+)\]/g)) {
    if (!context.evidenceIds.includes(reference[1])) return 'unknown_component_reference'
  }

  if (COMPATIBILITY_CLAIM.test(prose)) return 'compatibility_claim'

  return null
}

/**
 * Figures a reader would act on: money, percentages, and `Nx` multiples.
 *
 * Bare numbers are deliberately not extracted. "Two components cover this" and "step 3" are ordinary prose, and
 * rejecting them would send every explanation to the fallback — a check that always fires is the same as no
 * check, because the model output stops being used at all and the failure becomes invisible.
 *
 * Normalised to digits only, so "EUR 1,200" and "€1200" compare equal against the estimate text.
 */
export function extractFigures(text: string): string[] {
  const figures = new Set<string>()

  // Money: a currency symbol or ISO code adjacent to a number, in either order.
  for (const match of text.matchAll(/(?:[€$£¥]|\b(?:eur|usd|gbp|dkk|sek|nok|chf|jpy)\b)\s?([\d,.\s]+\d)/gi)) {
    figures.add(digitsOnly(match[1]))
  }
  for (const match of text.matchAll(/([\d,.\s]*\d)\s?(?:[€$£¥]|\b(?:eur|usd|gbp|dkk|sek|nok|chf|jpy)\b)/gi)) {
    figures.add(digitsOnly(match[1]))
  }
  // Percentages and multiples — the shape a performance claim takes.
  for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s?%/g)) figures.add(`pct:${digitsOnly(match[1])}`)
  for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s?x\b/gi)) figures.add(`mult:${digitsOnly(match[1])}`)

  return [...figures]
}

/** Every figure the composer's own estimate text contains, in the same normalised form. */
function allowedFigures(estimateText: string): Set<string> {
  return new Set(extractFigures(estimateText))
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

/**
 * Wording that asserts two things work together.
 *
 * The compatibility graph decides that, and it is not in what the model was given. Matched narrowly on verbs
 * about relationships between things rather than on the word "integration" alone — a brief may legitimately
 * *require* an integration, and an explanation is allowed to say the route covers that requirement.
 */
const COMPATIBILITY_CLAIM = /\b(?:integrates? (?:with|into)|compatible with|works? (?:well )?(?:with|alongside)|plugs? into|interoperates?)\b/i

/** The route's own estimate, formatted once so the prompt and the figure allowlist cannot disagree. */
export function formatEstimate(route: SolutionRoute): string {
  if (!route.estimate) return ''
  const { costMinCents, costMaxCents, currency, timeMinHours, timeMaxHours } = route.estimate
  const money = costMaxCents === 0
    ? 'no direct cost'
    : `${currency} ${(costMinCents / 100).toFixed(0)}–${(costMaxCents / 100).toFixed(0)}`
  return `${money}, ${timeMinHours}–${timeMaxHours} hours`
}

/**
 * The composer's own text, unchanged.
 *
 * Not a degraded imitation of an explanation: these are the sentences the deterministic composer wrote from the
 * route it built, so they are the most defensible description of the route that exists. The model's version is
 * an improvement in readability, and losing it costs nothing that matters.
 */
function deterministic(route: SolutionRoute, reason: ExplainFallbackReason): ExplainedRoute {
  return {
    summary: route.summary,
    fitExplanation: route.fitExplanation,
    provenance: 'deterministic',
    fallbackReason: reason,
    citedEvidenceIds: [...route.evidenceIds],
    promptVersion: null,
  }
}
