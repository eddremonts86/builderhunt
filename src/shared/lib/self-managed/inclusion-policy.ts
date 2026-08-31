import { INTERNAL_ORIGIN_NAMES } from '~/lib/sources/types'

/**
 * The one place that decides whether a matching surface includes self-managed profiles
 * (plan: phase-2/07-perfiles-autogestionados, §"Principio de cobertura universal en matching").
 *
 * ## Why a module and not four `if`s
 *
 * Search, recommendations, sprint shortlists and alerts each ask the same question, and the spec's
 * rule has three parts that are easy to get subtly different: included by default, filterable by
 * the person, and never hidden without them asking. Four copies of that is four chances for one to
 * drift — and the copy that drifts is the one that quietly stops returning a whole class of people,
 * which nobody reports because nothing looks broken.
 *
 * ## Precedence: the surface first, then the person, then the default
 *
 * From the spec: "El toggle global solo se aplica si el toggle por superficie no está definido."
 * A sprint that says `false` means this shortlist, not this account — an organiser narrowing one
 * search must not silently rewrite the searcher's standing preference, and a standing preference
 * must not override a decision somebody just made on the screen in front of them.
 *
 * `undefined`/`null` is "never chosen" at both levels and is **not** `false`. Collapsing them would
 * make a default change overwrite the choice of everyone who had actually answered.
 *
 * ## What this module does not decide
 *
 * Eligibility. Whether a profile is public, undeleted and unsuppressed is decided where the rows
 * come from — the origin's query filters `visibility = 'public'` and `deleted_at is null`, and
 * `filterSuppressed` runs before ranking on every path. A second copy of those predicates here
 * would be a second thing to keep in step with the row policies, and the one that lags is the one
 * that shows a withdrawn profile.
 *
 * And permissions. An opt-out changes what a list contains and nothing else: it grants nothing,
 * revokes nothing, and never reorders the rows that were going to be there anyway.
 */
export const SELF_MANAGED_ORIGIN = 'self-managed'

/** Compile-time proof that the origin this policy names is the one the search layer knows. */
const _originIsKnown: (typeof INTERNAL_ORIGIN_NAMES)[number] = SELF_MANAGED_ORIGIN

export type InclusionReason = 'default-on' | 'account-opted-out' | 'surface-opted-out' | 'surface-opted-in'

export interface InclusionDecision {
  include: boolean
  /** Why, so a surface can say "you turned these off" rather than showing an unexplained gap. */
  reason: InclusionReason
}

export interface InclusionInput {
  /** `user_preferences.search_include_self_managed`. `null`/`undefined` means never chosen. */
  accountPreference?: boolean | null
  /** A per-resource choice — a sprint's own field. `null`/`undefined` means the resource is silent. */
  surfacePreference?: boolean | null
}

export function decideSelfManagedInclusion(input: InclusionInput = {}): InclusionDecision {
  if (input.surfacePreference === true) return { include: true, reason: 'surface-opted-in' }
  if (input.surfacePreference === false) return { include: false, reason: 'surface-opted-out' }
  if (input.accountPreference === false) return { include: false, reason: 'account-opted-out' }
  return { include: true, reason: 'default-on' }
}

/**
 * The source list a surface should actually search with.
 *
 * Appended, never inserted: the order of the caller's own sources is part of what the fan-out and
 * every downstream ranking already do, and reordering them to make room would change results for
 * people who never asked for this feature at all.
 *
 * Idempotent — a list that already names the origin comes back unchanged, so a caller that resolves
 * the policy twice cannot search the same origin twice.
 */
export function withSelfManagedOrigin(
  sources: readonly string[],
  decision: InclusionDecision,
): string[] {
  const withoutOrigin = sources.filter((source) => source !== SELF_MANAGED_ORIGIN)
  return decision.include ? [...withoutOrigin, SELF_MANAGED_ORIGIN] : withoutOrigin
}

/** Whether a row came from this origin. One predicate, so no surface invents its own test. */
export function isSelfManagedRow(row: { source?: string | null }): boolean {
  return row.source === SELF_MANAGED_ORIGIN
}

/**
 * Drop self-managed rows from a list that was produced without the policy.
 *
 * For the surfaces that cannot express the decision as a source list — anything reading a cache, a
 * stored shortlist or a pre-computed set. Filtering after the fact is the weaker half of the same
 * rule and is deliberately separate: it costs a wasted fetch, so a caller that *can* pass the
 * source list should.
 */
export function applySelfManagedInclusion<T extends { source?: string | null }>(
  rows: readonly T[],
  decision: InclusionDecision,
): T[] {
  if (decision.include) return [...rows]
  return rows.filter((row) => !isSelfManagedRow(row))
}

/** What a surface renders next to a name. Never the verified badge, and never absent. */
export interface SelfManagedProvenance {
  isSelfManaged: boolean
  /** The chip's exact label, so no surface can invent a kinder synonym for "unverified". */
  chipLabel: 'Self-managed' | null
}

export function provenanceFor(row: { source?: string | null }): SelfManagedProvenance {
  const isSelfManaged = isSelfManagedRow(row)
  return { isSelfManaged, chipLabel: isSelfManaged ? 'Self-managed' : null }
}

/**
 * Attach provenance to every row of a result set.
 *
 * Every row, not only the self-managed ones: a field present on some rows and absent on others is a
 * field a renderer reads as `undefined` and quietly treats as "no chip", which is exactly the
 * failure the spec's "el chip nunca se omite por error visual" forbids.
 */
export function decorateSelfManagedProvenance<T extends { source?: string | null }>(
  rows: readonly T[],
): Array<T & SelfManagedProvenance> {
  return rows.map((row) => ({ ...row, ...provenanceFor(row) }))
}
