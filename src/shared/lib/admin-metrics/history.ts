import { ROUTE_FAMILIES, type RouteFamily } from './contracts'

/**
 * Turning request paths into families, and bucketed counts into percentiles (plan 57, Admin track —
 * "Add truthful historical service-metric storage or adapter").
 *
 * Two pure halves, both of them the parts that are easy to get quietly wrong:
 *
 * - **`routeFamilyFor`** is the "high-cardinality URLs/IDs are normalized or rejected" half of the Verify
 *   line. It maps a path to one of fourteen families and never stores the path.
 * - **`percentileFrom`** is the "reconcile across process restart and multiple instances" half. It reads
 *   summed histogram counts, which is why the storage is counts rather than means.
 *
 * Kept free of the database on purpose: both are exactly the logic worth testing exhaustively, and neither
 * needs a connection to be tested.
 */

/**
 * Fixed latency boundaries, in milliseconds, plus one implicit overflow slot.
 *
 * Code-owned and effectively part of the schema: rows written under one boundary list cannot be summed
 * with rows written under another, so changing this is a data migration and not a constant edit. The
 * array stored per row is `LATENCY_BOUNDARIES_MS.length + 1` long — one count per boundary, plus
 * everything slower than the last.
 *
 * The spacing is roughly logarithmic because that is where the resolution is needed: the difference
 * between 5 ms and 10 ms matters for a cache hit, the difference between 5 s and 10 s does not matter at
 * all because both are already a failed request as far as a person is concerned.
 */
export const LATENCY_BOUNDARIES_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const

/** One count per boundary, plus the overflow. */
export const LATENCY_SLOTS = LATENCY_BOUNDARIES_MS.length + 1

/** A fresh, correctly sized histogram. */
export function emptyHistogram(): number[] {
  return new Array(LATENCY_SLOTS).fill(0)
}

/**
 * Which slot a duration lands in.
 *
 * `<=`, not `<`: a boundary of 100 means "100 ms or faster", so a request that took exactly 100 ms is not
 * pushed into the 250 slot. Off-by-one here would bias every percentile in the slow direction, which is
 * the direction that looks like a regression.
 */
export function slotFor(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) return -1
  for (const [index, boundary] of LATENCY_BOUNDARIES_MS.entries()) {
    if (durationMs <= boundary) return index
  }
  return LATENCY_SLOTS - 1
}

/** Adds one observation. Returns the same array, so a caller can accumulate in place. */
export function observe(histogram: number[], durationMs: number): number[] {
  const slot = slotFor(durationMs)
  // A negative or non-finite duration is not a slow request, it is a bug in the caller. Dropping it keeps
  // the histogram summable; folding it into slot 0 would make the fastest bucket a dumping ground.
  if (slot >= 0) histogram[slot] += 1
  return histogram
}

/**
 * Sums histograms elementwise — the operation the whole storage shape exists to allow.
 *
 * This is what makes a percentile reconcile across instances and restarts: three rows from three
 * instances in the same minute, or two rows from before and after a deploy, add up to one distribution.
 * Rows of the wrong length are refused rather than padded, because a padded row silently attributes its
 * missing slots to "fast".
 */
export function sumHistograms(histograms: readonly (readonly number[])[]): number[] {
  const total = emptyHistogram()
  for (const histogram of histograms) {
    if (histogram.length !== LATENCY_SLOTS) {
      throw new Error(
        `histogram has ${histogram.length} slots, expected ${LATENCY_SLOTS} — it was written under a ` +
          'different boundary list and cannot be summed with these',
      )
    }
    for (let slot = 0; slot < LATENCY_SLOTS; slot += 1) total[slot] += histogram[slot]
  }
  return total
}

/**
 * A percentile from bucketed counts, reported as the boundary it falls in.
 *
 * Returns the *boundary*, not an interpolated value, and that is a deliberate loss of precision in favour
 * of not inventing precision: with 1,000 observations in the 100 ms bucket there is no information about
 * where inside it the 95th sits, and interpolating would produce a number like `173 ms` that reads as a
 * measurement. `null` for an empty histogram rather than `0` — no observations is not "instant", and the
 * contract's units make `0 ms` a claim.
 *
 * The overflow slot reports `null` too, with `overflow: true`: everything past the last boundary is
 * "slower than 10 s", and naming a number there would be a fabrication.
 */
export function percentileFrom(
  histogram: readonly number[],
  quantile: number,
): { atMostMs: number | null; overflow: boolean; samples: number } {
  if (quantile <= 0 || quantile > 1) throw new RangeError('quantile must be in (0, 1]')
  const samples = histogram.reduce((sum, count) => sum + count, 0)
  if (samples === 0) return { atMostMs: null, overflow: false, samples: 0 }

  // Nearest-rank: the smallest boundary whose cumulative count reaches the target rank.
  const target = Math.ceil(quantile * samples)
  let cumulative = 0
  for (let slot = 0; slot < histogram.length; slot += 1) {
    cumulative += histogram[slot]
    if (cumulative >= target) {
      const boundary = LATENCY_BOUNDARIES_MS[slot]
      return boundary === undefined
        ? { atMostMs: null, overflow: true, samples }
        : { atMostMs: boundary, overflow: false, samples }
    }
  }
  // Unreachable while the counts are non-negative, which the CHECK constraints enforce on the way in.
  return { atMostMs: null, overflow: true, samples }
}

/**
 * Path to route family, or `other`.
 *
 * ## Why this exists rather than a path column
 *
 * `/api/sprints/abc123` names a real sprint, `/builders/gh_12345` names a real person. Storing paths would
 * put tenant and personal identifiers into an operator table and into every export of it, and it would let
 * traffic decide the table's cardinality — one crawler hitting generated URLs is enough to turn a ranking
 * into ten thousand rows.
 *
 * ## Why unrecognised becomes `other` rather than being dropped
 *
 * Dropping it would understate total traffic, and the totals are what a rate is computed from. `other`
 * keeps the arithmetic honest while carrying no identifier: it is the one label that says "counted, not
 * attributed".
 */
export function routeFamilyFor(pathname: string): RouteFamily {
  // Query and fragment carry the most identifiers of anything in a URL and never affect the family.
  const path = pathname.split('?')[0].split('#')[0]
  if (!path.startsWith('/')) return 'other'

  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) return 'page.public'

  if (segments[0] === 'api') {
    const group = segments[1]
    const candidate = `api.${group}` as RouteFamily
    if ((ROUTE_FAMILIES as readonly string[]).includes(candidate)) return candidate
    /**
     * Everything under `/api/public/*` is one family even when its second segment varies, because that is
     * the boundary an operator cares about — "was this an authenticated call or an anonymous one".
     */
    if (group === 'public') return 'api.public'
    return 'other'
  }

  /**
   * `page.dashboard` covers the authenticated shell.
   *
   * The list is short and explicit rather than "anything not public", because a new top-level route
   * silently joining the authenticated family would move traffic between two lines on a chart with no
   * code change — and the wrong direction to be wrong is the one that happens by itself.
   */
  const dashboardRoots = new Set(['dashboard', 'search', 'sprints', 'alerts', 'exports', 'settings', 'admin', 'me', 'lists', 'solutions', 'calendar', 'interviews', 'team'])
  if (dashboardRoots.has(segments[0])) return 'page.dashboard'

  const publicRoots = new Set(['', 'pricing', 'explore', 'blog', 'changelog', 'roadmap', 'legal', 'status', 'security', 'builders', 'auth', 'onboarding'])
  if (publicRoots.has(segments[0])) return 'page.public'

  return 'other'
}

/** Whether a family is one this build knows. Used on the read path to refuse a row written by an older one. */
export function isKnownFamily(value: string): value is RouteFamily {
  return (ROUTE_FAMILIES as readonly string[]).includes(value)
}
