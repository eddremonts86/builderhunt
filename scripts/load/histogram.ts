/**
 * Latency percentiles without keeping every sample (plan 55 phase 0).
 *
 * ## Why a histogram and not an array
 *
 * A two-hour soak at 444 req/s is about 3.2 million requests. Retaining each one to sort at the end is
 * ~25 MB of numbers per route, and the report's own `maxRssGrowthRatio` threshold is 10% — so the
 * measurement would consume the budget it is measuring. Worse, it would grow monotonically for two hours
 * and make every RSS figure in the report a statement about the runner rather than about the app.
 *
 * ## The resolution, and what it costs
 *
 * Fixed 1 ms buckets up to 10 s, which is the request timeout — anything slower has already been counted
 * as a timeout, so there is nothing above the last bucket to lose. That is 10,000 counters, ~80 KB,
 * constant for any run length.
 *
 * A percentile is therefore accurate to ±1 ms. Every threshold in the spec is stated in whole
 * milliseconds and the tightest is 250 ms, so 1 ms is two orders of magnitude finer than the decision it
 * informs. Stating the bound rather than implying exactness is the point: `p95 = 1499` from this
 * histogram means "between 1499 and 1500", and that is still a clean pass against 1500.
 */

/** The request timeout, and therefore the top of the histogram. Anything slower is a timeout, not a sample. */
export const HISTOGRAM_CEILING_MS = 10_000

export class LatencyHistogram {
  private readonly buckets = new Uint32Array(HISTOGRAM_CEILING_MS + 1)
  private count = 0
  private sumMs = 0
  private maxMs = 0

  /**
   * `Math.round`, not `Math.floor`.
   *
   * Flooring biases every percentile down by up to a millisecond, systematically and in the direction that
   * makes a run look faster than it was. On a threshold decision that is the wrong way to be wrong.
   */
  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    const bucket = Math.min(HISTOGRAM_CEILING_MS, Math.round(durationMs))
    this.buckets[bucket] += 1
    this.count += 1
    this.sumMs += durationMs
    if (durationMs > this.maxMs) this.maxMs = durationMs
  }

  get samples(): number {
    return this.count
  }

  get meanMs(): number {
    return this.count === 0 ? 0 : this.sumMs / this.count
  }

  get maxObservedMs(): number {
    return this.maxMs
  }

  /**
   * The nearest-rank percentile: the smallest value at or below which at least `q` of the samples fall.
   *
   * Returns `null` for an empty histogram rather than 0. Zero would read as "instant" in a report, and a
   * route that was never exercised has no latency at all — which is a fixture problem the report must be
   * able to show rather than a fast route.
   */
  percentileMs(q: number): number | null {
    if (q <= 0 || q > 1) throw new RangeError(`percentile must be within (0, 1], got ${q}`)
    if (this.count === 0) return null
    const target = Math.ceil(q * this.count)
    let seen = 0
    for (let bucket = 0; bucket <= HISTOGRAM_CEILING_MS; bucket += 1) {
      seen += this.buckets[bucket]
      if (seen >= target) return bucket
    }
    return HISTOGRAM_CEILING_MS
  }

  /** Merges another histogram in place — used to total per-route histograms without a second pass. */
  merge(other: LatencyHistogram): void {
    for (let bucket = 0; bucket <= HISTOGRAM_CEILING_MS; bucket += 1) {
      this.buckets[bucket] += other.buckets[bucket]
    }
    this.count += other.count
    this.sumMs += other.sumMs
    if (other.maxMs > this.maxMs) this.maxMs = other.maxMs
  }

  summary(): LatencySummary {
    return {
      samples: this.count,
      meanMs: Math.round(this.meanMs),
      p50Ms: this.percentileMs(0.5),
      p95Ms: this.percentileMs(0.95),
      p99Ms: this.percentileMs(0.99),
      maxMs: Math.round(this.maxMs),
      /** So a reader of the report knows a percentile here is ±1 ms rather than exact. */
      resolutionMs: 1,
    }
  }
}

export interface LatencySummary {
  samples: number
  meanMs: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  maxMs: number
  resolutionMs: number
}
