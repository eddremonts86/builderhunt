import {
  ADMIN_METRIC_RANGES,
  ADMIN_METRIC_SECTIONS,
  variantsFor,
  type AdminMetricRange,
  type AdminMetricSection,
} from './contracts'

/**
 * The Admin Metrics page's URL state (plan 57, Admin track — "Rebuild `/admin/metrics` as a route-driven
 * lazy widget shell").
 *
 * ## Why this normalizes where `parseSectionRequest` refuses
 *
 * They are the same allowlists and deliberately opposite policies, because the two callers have opposite
 * correct answers.
 *
 * The **API** refuses: a request for `section=surveillance` is a caller mistake, and answering it with a
 * defaulted section would return a payload that does not match what was asked for — the client would render
 * runtime numbers under a traffic heading and have no way to know.
 *
 * The **page** normalizes: a URL is something a human edits, shortens, or pastes from a stale bookmark, and
 * a 400 on a metrics page during an incident is worse than the overview. So an unrecognised value falls back
 * and the URL is *rewritten* to what is actually being shown — see `AdminMetricsShell`. Silently rendering
 * the overview while the address bar still says `traffic` is the failure this avoids: the operator would
 * share that URL.
 *
 * Both are built from `ADMIN_METRIC_SECTIONS` / `ADMIN_METRIC_RANGES` / `variantsFor`, so a section or range
 * added to the contract cannot be missing here.
 */

/** What the route hands the shell. Every field is present after validation, never `undefined`. */
export interface AdminMetricsUrlState {
  section: AdminMetricSection
  range: AdminMetricRange
  variant: string
  /**
   * Whether to request the previous window alongside the current one.
   *
   * Off by default because it doubles the query cost of every section, and a comparison nobody asked for is
   * the kind of thing that makes a metrics page expensive on a refresh timer.
   */
  compare: boolean
}

export const DEFAULT_SECTION: AdminMetricSection = 'overview'
export const DEFAULT_RANGE: AdminMetricRange = '24h'

/**
 * The complete default state, exported because every `Link` to this route has to supply the whole object.
 *
 * `validateSearch` makes all four fields present in the route's search type, so the router requires all four
 * at every link — which is the behaviour worth having (a link that omits one would silently reset it), but it
 * means the defaults need one home. Written out here rather than assembled by calling the normalizer with an
 * empty object, so it is a value a redirect can use without running anything.
 */
export const DEFAULT_ADMIN_METRICS_SEARCH: AdminMetricsUrlState = {
  section: DEFAULT_SECTION,
  range: DEFAULT_RANGE,
  variant: variantsFor(DEFAULT_SECTION)[0],
  compare: false,
}

/**
 * Normalizes whatever arrived in the query string.
 *
 * The variant is resolved *against the resolved section*, not the requested one: `?section=nonsense&
 * variant=latency` must not carry traffic's variant onto the overview, because `overview` has no `latency`
 * and the request would then 400 on a URL the page itself produced.
 */
export function normalizeAdminMetricsSearch(input: Record<string, unknown>): AdminMetricsUrlState {
  const section = ADMIN_METRIC_SECTIONS.find((candidate) => candidate === input.section) ?? DEFAULT_SECTION
  const range = ADMIN_METRIC_RANGES.find((candidate) => candidate === input.range) ?? DEFAULT_RANGE
  const allowed = variantsFor(section)
  const variant = allowed.find((candidate) => candidate === input.variant) ?? allowed[0]
  // Only the string `true` enables it, so `?compare=0`, `?compare=false` and `?compare=` all mean off.
  const compare = input.compare === true || input.compare === 'true'
  return { section, range, variant, compare }
}

/**
 * Whether the normalized state differs from what the URL literally said.
 *
 * The shell uses this to decide whether to rewrite the address bar. Comparing the *inputs* rather than
 * re-normalizing twice matters for `compare`: `?compare=false` normalizes to `false`, which is also the
 * default, and rewriting it away would fight an operator who typed it deliberately.
 */
export function searchNeedsRewrite(
  input: Record<string, unknown>,
  normalized: AdminMetricsUrlState,
): boolean {
  if (input.section !== undefined && input.section !== normalized.section) return true
  if (input.range !== undefined && input.range !== normalized.range) return true
  if (input.variant !== undefined && input.variant !== normalized.variant) return true
  return false
}

/**
 * The search state a bare `/admin/metrics` should be redirected to, or `null` for "leave it alone".
 *
 * Not simply "the saved view". Two things have to be true before a redirect is worth firing:
 *
 * 1. **It resolves to something this build can render.** Run through `normalizeAdminMetricsSearch` — the same
 *    normalizer `validateSearch` uses — rather than a second copy of the vocabulary checks. A stored row can name
 *    a section a later build removed, and redirecting to it would bounce through `validateSearch` back to the
 *    overview: a visible flicker on every load, for a preference nobody can act on. Reusing the normalizer also
 *    means a section added to the contract needs no change here.
 * 2. **It differs from where a bare URL already lands.** An admin who has never saved anything reads back the
 *    defaults, so without this the redirect would fire on every visit and add a history entry to arrive at the
 *    page it was already going to render.
 *
 * `compare` comes from the defaults, never from the preference: the store does not hold it, and an admin who
 * saved it on would open every session paying for two windows.
 */
export function landingRedirectTarget(
  landing: { section: string; range: string; variant: string } | null,
  defaults: AdminMetricsUrlState,
): AdminMetricsUrlState | null {
  if (!landing) return null
  const resolved = normalizeAdminMetricsSearch({
    section: landing.section,
    range: landing.range,
    variant: landing.variant,
    compare: defaults.compare,
  })
  const same =
    resolved.section === defaults.section &&
    resolved.range === defaults.range &&
    resolved.variant === defaults.variant
  return same ? null : resolved
}
