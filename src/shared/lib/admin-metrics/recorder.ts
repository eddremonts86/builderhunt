import type { RouteFamily } from './contracts'
import { emptyHistogram, LATENCY_SLOTS, observe, routeFamilyFor } from './history'

/**
 * Accumulates one minute of service metrics in memory, then hands it over as a **delta** (plan 57, Admin
 * track — "Add truthful historical service-metric storage or adapter").
 *
 * ## Why an accumulator and not a write per request
 *
 * A row per request would put a database write on the hot path of every request, including the ones being
 * measured — so the act of measuring would change the number. One row per minute per family per instance
 * is a handful of writes a minute regardless of traffic, and it is the granularity every read actually
 * wants.
 *
 * ## Why the accumulator resets on hand-over, and never reports a total
 *
 * This is the rule the storage exists for. `take()` returns what happened since the last `take()` and
 * clears itself, so what reaches the database is always a delta. Nothing here exposes a cumulative figure,
 * because a cumulative figure is what invites somebody to subtract two of them — and subtraction breaks
 * across a deploy (negative) and across instances (meaningless). The counters in `metrics.ts` remain
 * cumulative for the runtime section, which is a different question honestly answered.
 *
 * ## Why it drops on the floor rather than growing
 *
 * `MAX_TRACKED_MINUTES` bounds the map. If a flush fails repeatedly — the database is down, which is
 * exactly when a metrics buffer is tempting to grow — the oldest minutes are discarded rather than
 * retained. An observability buffer that can exhaust memory turns a database outage into an application
 * outage, and the metrics are the least important thing in the process at that moment.
 */

/**
 * Ten minutes of buffer. Long enough to ride out a flush failure or two, short enough that the worst case
 * is bounded at (10 minutes × 14 families) rows of counters, which is kilobytes.
 */
const MAX_TRACKED_MINUTES = 10

export interface MinuteKey {
  bucketStart: Date
  routeFamily: RouteFamily
}

export interface MinuteDelta {
  bucketStart: Date
  routeFamily: RouteFamily
  requests: number
  errors: number
  searches: number
  searchCacheHits: number
  latencyBuckets: number[]
}

interface Accumulated {
  requests: number
  errors: number
  searches: number
  searchCacheHits: number
  latencyBuckets: number[]
}

/** Minute precision, UTC. The bucket a moment belongs to. */
export function minuteOf(at: Date): Date {
  const truncated = new Date(at.getTime())
  truncated.setUTCSeconds(0, 0)
  return truncated
}

function keyFor(bucketStart: Date, routeFamily: RouteFamily): string {
  return `${bucketStart.toISOString()}|${routeFamily}`
}

export class ServiceMetricRecorder {
  private readonly minutes = new Map<string, MinuteDelta>()

  /**
   * Records one request.
   *
   * The path is normalised to a family here rather than at the write, so a raw path never enters even the
   * in-memory map — the map is a heap object that a crash dump or a debugger would show.
   */
  record(input: { pathname: string; status: number; durationMs: number; at?: Date }): void {
    const bucketStart = minuteOf(input.at ?? new Date())
    const routeFamily = routeFamilyFor(input.pathname)
    const entry = this.entryFor(bucketStart, routeFamily)
    entry.requests += 1
    // 5xx only. A 404 or a 401 is the application working, and folding them into an error rate makes a
    // crawler probing for `/wp-admin` look like an incident.
    if (input.status >= 500) entry.errors += 1
    observe(entry.latencyBuckets, input.durationMs)
  }

  /**
   * Counts one search, always under `api.search`.
   *
   * Attributed to the search, not to the request that carried it. `searchBuildersWithStatus` is called from
   * the search API and from page loaders, and spreading its cache-hit rate across `page.public` and
   * `api.search` would make the rate depend on which surface happened to be popular that hour — a number
   * that moves for a reason that has nothing to do with the cache. One family keeps the ratio meaningful.
   */
  recordSearch(at?: Date): void {
    this.entryFor(minuteOf(at ?? new Date()), 'api.search').searches += 1
  }

  /**
   * Counts one cache hit, and deliberately **not** a search.
   *
   * Two methods rather than `recordSearch({ cacheHit })` because the call sites are not one place: the
   * search is counted once on entry, and the hit is discovered later in one of two early-return branches.
   * A single method taking the outcome would have to be called twice on a hit — once not knowing, once
   * knowing — and the second call would count a second search. That is precisely the double-count that
   * makes a hit rate exceed 100 %, and the shape is invisible in review because both calls look correct.
   *
   * As written, each call here sits directly under the `metrics.increment` it mirrors in `lib/search.ts`,
   * so the two counters cannot drift apart without the diff showing it.
   */
  recordSearchCacheHit(at?: Date): void {
    this.entryFor(minuteOf(at ?? new Date()), 'api.search').searchCacheHits += 1
  }

  private entryFor(bucketStart: Date, routeFamily: RouteFamily): Accumulated {
    const key = keyFor(bucketStart, routeFamily)
    const existing = this.minutes.get(key)
    if (existing) return existing

    /**
     * Evicts the oldest minute rather than growing.
     *
     * Checked before insert, so the map never exceeds the bound even momentarily. Oldest-first because the
     * newest minute is the one a reader is most likely to want and the one most likely to still be
     * flushable.
     */
    if (this.minutes.size >= MAX_TRACKED_MINUTES * 14) {
      const oldest = [...this.minutes.keys()].sort()[0]
      if (oldest) this.minutes.delete(oldest)
    }

    const created: MinuteDelta = {
      bucketStart,
      routeFamily,
      requests: 0,
      errors: 0,
      searches: 0,
      searchCacheHits: 0,
      latencyBuckets: emptyHistogram(),
    }
    this.minutes.set(key, created)
    return created
  }

  /**
   * Hands over every complete minute and clears them.
   *
   * The *current* minute is deliberately left behind: flushing it would write a partial minute, and the
   * next flush would add the rest — which is correct arithmetic under the additive upsert, but means any
   * read landing between the two sees a minute that is real and incomplete. Holding it back by up to sixty
   * seconds costs freshness that nobody can act on and buys a series where every complete bucket is
   * complete.
   */
  take(now: Date = new Date()): MinuteDelta[] {
    const currentMinute = minuteOf(now).getTime()
    const ready: MinuteDelta[] = []
    for (const [key, delta] of this.minutes) {
      if (delta.bucketStart.getTime() >= currentMinute) continue
      ready.push(delta)
      this.minutes.delete(key)
    }
    return ready
  }

  /** For a flush that failed: put the minutes back so the next attempt carries them. */
  restore(deltas: readonly MinuteDelta[]): void {
    for (const delta of deltas) {
      const key = keyFor(delta.bucketStart, delta.routeFamily)
      const existing = this.minutes.get(key)
      if (!existing) {
        this.minutes.set(key, delta)
        continue
      }
      // Merge rather than replace: traffic kept arriving while the flush was in flight.
      existing.requests += delta.requests
      existing.errors += delta.errors
      existing.searches += delta.searches
      existing.searchCacheHits += delta.searchCacheHits
      for (let slot = 0; slot < LATENCY_SLOTS; slot += 1) {
        existing.latencyBuckets[slot] += delta.latencyBuckets[slot]
      }
    }
  }

  /** Buffered minutes, for a test or a health readout. Never a cumulative request total. */
  get bufferedMinutes(): number {
    return this.minutes.size
  }
}

/**
 * The process-wide recorder.
 *
 * One per process, like `metrics.ts`'s counters, because that is what an instance's minute means.
 */
export const serviceMetricRecorder = new ServiceMetricRecorder()
