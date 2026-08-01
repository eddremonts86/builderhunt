/**
 * Covering a brief's capabilities with candidates, and traversing compatibility edges (plan 43 Phase 5,
 * "Implement the deterministic solution composer": "Cover required capabilities with approved versioned
 * edges ... place human reviews").
 *
 * Pure and deterministic: same candidates in, same assignment out. That is not a style preference — a
 * solution run records the component versions it cited so a recommendation can be audited later, and an
 * assignment that varied between two runs of one brief would make the citation meaningless.
 */
import type { CapabilityEvidenceLevel } from '~/shared/lib/solutions/contracts'
import { evidenceRank } from '~/lib/solutions/indexing/projection-doc'

export interface CoverageCandidate {
  componentId: string
  componentVersion: number
  displayName: string
  kind: string
  capabilityKeys: readonly string[]
  maxEvidenceLevel: CapabilityEvidenceLevel
  /** Retrieval's final score. Used only to order equally-covering candidates. */
  score: number
  /** Where a reviewer can check the claim. */
  evidenceIds?: readonly string[]
  homepageUrl?: string | null
}

export interface CoverageAssignment {
  componentId: string
  componentVersion: number
  displayName: string
  kind: string
  /** Which of the brief's capabilities this component was chosen for. Never the full claim list — a
   * component claiming eight capabilities is not doing eight jobs in this route. */
  coveredCapabilityKeys: string[]
  evidenceLevel: CapabilityEvidenceLevel
  homepageUrl?: string | null
}

export interface CoverageResult {
  assignments: CoverageAssignment[]
  /** Requested capabilities nothing in the candidate set claims. */
  gaps: string[]
  /** True when every requested capability is claimed by some assignment. */
  complete: boolean
}

/**
 * Assigns the fewest candidates that cover the most capabilities.
 *
 * A greedy set cover, and greedy is the right choice here for a reason beyond simplicity: the optimal set
 * cover is NP-hard, and a route with one extra component is a mild cost, while a route whose composition
 * changes shape because an exact solver found a different optimum of equal size is an unreproducible
 * recommendation.
 *
 * Ties are broken in a fixed order — more new capabilities, then stronger evidence, then higher retrieval
 * score, then component id. The final tiebreak on id is what makes the whole thing deterministic; without it
 * two candidates with identical everything would be ordered by whatever the database returned first.
 *
 * Evidence beats score, not the other way round. Given two components that cover the same gap, the one with a
 * verified claim is the better recommendation even if the other matched the query text more closely: the
 * question is "can this do the job", and evidence answers it while lexical similarity only suggests it.
 */
export function coverCapabilities(
  requested: readonly string[],
  candidates: readonly CoverageCandidate[],
  maxComponents = 4,
): CoverageResult {
  const remaining = new Set(requested)
  const assignments: CoverageAssignment[] = []
  const used = new Set<string>()

  while (remaining.size > 0 && assignments.length < maxComponents) {
    let best: { candidate: CoverageCandidate; covers: string[] } | null = null

    for (const candidate of candidates) {
      if (used.has(candidate.componentId)) continue
      const covers = [...remaining].filter((key) => candidate.capabilityKeys.includes(key))
      if (covers.length === 0) continue
      if (!best || isBetter(candidate, covers, best)) best = { candidate, covers }
    }

    if (!best) break
    used.add(best.candidate.componentId)
    assignments.push({
      componentId: best.candidate.componentId,
      componentVersion: best.candidate.componentVersion,
      displayName: best.candidate.displayName,
      kind: best.candidate.kind,
      coveredCapabilityKeys: [...best.covers].sort(),
      evidenceLevel: best.candidate.maxEvidenceLevel,
      homepageUrl: best.candidate.homepageUrl ?? null,
    })
    for (const key of best.covers) remaining.delete(key)
  }

  return {
    assignments,
    gaps: [...remaining].sort(),
    complete: remaining.size === 0,
  }
}

function isBetter(
  candidate: CoverageCandidate,
  covers: readonly string[],
  best: { candidate: CoverageCandidate; covers: string[] },
): boolean {
  if (covers.length !== best.covers.length) return covers.length > best.covers.length
  const evidence = evidenceRank(candidate.maxEvidenceLevel) - evidenceRank(best.candidate.maxEvidenceLevel)
  if (evidence !== 0) return evidence > 0
  if (candidate.score !== best.candidate.score) return candidate.score > best.candidate.score
  return candidate.componentId < best.candidate.componentId
}

export interface CompatibilityEdge {
  edgeType: string
  fromComponentId: string
  toComponentId: string
}

export interface CompatibilityOutcome {
  /** Pairs the graph says must not be combined. A route containing one is unavailable. */
  incompatiblePairs: Array<{ from: string; to: string }>
  /** Components a route depends on that it does not include. Named so a caller can add them. */
  missingRequirements: Array<{ componentId: string; requires: string }>
  /** Components that cannot be ordered because they require each other. */
  cycles: string[][]
}

/**
 * Checks an assignment against the active compatibility graph.
 *
 * Only edges the caller loaded, and `listTraversableEdges` loads only `status = 'active'` with an open
 * validity window. A `proposed` edge reaching here would put an unreviewed combination into a
 * recommendation, which is what `solution_edges_similarity_needs_review_check` exists to prevent — so the
 * narrowing stays in SQL and this function trusts its input.
 */
export function checkCompatibility(
  componentIds: readonly string[],
  edges: readonly CompatibilityEdge[],
): CompatibilityOutcome {
  const inRoute = new Set(componentIds)
  const incompatiblePairs: Array<{ from: string; to: string }> = []
  const missingRequirements: Array<{ componentId: string; requires: string }> = []
  const requires = new Map<string, Set<string>>()

  for (const edge of edges) {
    if (!inRoute.has(edge.fromComponentId)) continue

    if (edge.edgeType === 'incompatible_with' && inRoute.has(edge.toComponentId)) {
      // Recorded in a stable order so the same route reports the same pair on every run.
      const [from, to] = [edge.fromComponentId, edge.toComponentId].sort()
      if (!incompatiblePairs.some((pair) => pair.from === from && pair.to === to)) {
        incompatiblePairs.push({ from, to })
      }
      continue
    }

    if (edge.edgeType === 'requires') {
      if (!inRoute.has(edge.toComponentId)) {
        missingRequirements.push({ componentId: edge.fromComponentId, requires: edge.toComponentId })
      } else {
        const set = requires.get(edge.fromComponentId) ?? new Set<string>()
        set.add(edge.toComponentId)
        requires.set(edge.fromComponentId, set)
      }
    }
  }

  return { incompatiblePairs, missingRequirements, cycles: findCycles(requires) }
}

/**
 * Finds cycles in the `requires` graph.
 *
 * A cycle means the route cannot be ordered: A needs B in place first, B needs A. Not merely presentational —
 * a route's `steps` *are* an ordering, so a cyclic route would produce steps nobody can follow. Reported
 * rather than broken arbitrarily, because which edge to drop is a curation decision.
 *
 * Iterative with an explicit stack and a parent map, which makes it O(V+E). Two reasons, and the second was
 * found by a test rather than by inspection:
 *
 * - A recursive walk over a graph built from database rows can be made to overflow by the data, and this data
 *   is partly derived from third-party metadata.
 * - The first version carried a copied `path` array on every stack frame (`[...path, next]`) and searched it
 *   with `indexOf`. On a 5000-node chain that is ~12.5M array operations, and the test asserting it survives
 *   deep input timed out at five seconds rather than overflowing. Reconstructing the cycle from parents only
 *   when a back edge is actually found costs nothing on the common path.
 */
export function findCycles(requires: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = []
  const seen = new Set<string>()

  for (const root of [...requires.keys()].sort()) {
    if (seen.has(root)) continue

    const parent = new Map<string, string | null>([[root, null]])
    const onPath = new Set<string>()
    // `enter` frames descend; `exit` frames pop the node off the current path, which is what an explicit stack
    // has to do in place of a function return.
    const stack: Array<{ node: string; phase: 'enter' | 'exit' }> = [{ node: root, phase: 'enter' }]

    while (stack.length > 0) {
      const frame = stack.pop()!
      if (frame.phase === 'exit') {
        onPath.delete(frame.node)
        continue
      }
      if (onPath.has(frame.node)) continue
      seen.add(frame.node)
      onPath.add(frame.node)
      stack.push({ node: frame.node, phase: 'exit' })

      for (const next of [...(requires.get(frame.node) ?? [])].sort().reverse()) {
        if (onPath.has(next)) {
          const cycle = reconstructCycle(parent, frame.node, next)
          const normalised = rotateToSmallest(cycle)
          if (!cycles.some((existing) => existing.join('>') === normalised.join('>'))) cycles.push(normalised)
          continue
        }
        if (!parent.has(next)) parent.set(next, frame.node)
        stack.push({ node: next, phase: 'enter' })
      }
    }
  }
  return cycles
}

/** Walks parents back from the node that closed the cycle to the node it pointed at. */
function reconstructCycle(parent: ReadonlyMap<string, string | null>, from: string, target: string): string[] {
  const cycle = [target]
  let current: string | null | undefined = from
  // Bounded by the parent map: a malformed map cannot make this loop forever.
  while (current && current !== target && cycle.length <= parent.size) {
    cycle.push(current)
    current = parent.get(current)
  }
  return cycle.reverse()
}

function rotateToSmallest(cycle: readonly string[]): string[] {
  let smallestIndex = 0
  for (let index = 1; index < cycle.length; index += 1) {
    if (cycle[index] < cycle[smallestIndex]) smallestIndex = index
  }
  return [...cycle.slice(smallestIndex), ...cycle.slice(0, smallestIndex)]
}

/**
 * Where a human has to look, given what the route is made of.
 *
 * Not decoration, and not a generic "review the output" line. A route can only be `recommended` with a
 * coverage gap if the gap is explicitly delegated to a named review step — that is the contract's own
 * refinement on `solutionRouteSchema` — so these are what make an incomplete route offerable at all.
 *
 * The `claimed`-evidence point is the one that matters most: every capability an adapter reads from a vendor's
 * own metadata enters at `claimed`, and nothing promotes it. A route built entirely from claimed capabilities
 * is built on vendors' self-descriptions, and saying so is the difference between advice and marketing.
 */
export function humanReviewPoints(
  assignments: readonly CoverageAssignment[],
  gaps: readonly string[],
): string[] {
  const points: string[] = []

  for (const gap of gaps) {
    points.push(`A person covers "${gap.replace(/_/g, ' ')}" — no component in the catalog claims it`)
  }

  const claimedOnly = assignments.filter((assignment) => assignment.evidenceLevel === 'claimed')
  if (claimedOnly.length > 0 && claimedOnly.length === assignments.length) {
    points.push('Verify the output: every capability in this route is the vendor\'s own claim, unverified by us')
  } else if (claimedOnly.length > 0) {
    points.push(`Verify the work of ${claimedOnly.map((a) => a.displayName).join(', ')} — their capabilities are vendor claims`)
  }

  const hasHuman = assignments.some((assignment) => assignment.kind === 'human_profile' || assignment.kind === 'human_role')
  if (!hasHuman && assignments.length > 0) {
    // Plan 43's scope excludes autonomous action, so no route may run unattended. A sign-off step is not a
    // suggestion — it is the ceiling the product operates under.
    points.push('Sign off before delivery — this route has no person in it')
  }

  return points
}
