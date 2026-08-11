import { and, gte, lt, sql } from 'drizzle-orm'
import { platformDb, runtimeDb } from '../db/client'
import { serviceMetricBuckets } from '../db/schema'
import { workerDb } from '../db/worker-db'
import {
  isKnownFamily,
  LATENCY_SLOTS,
  percentileFrom,
  sumHistograms,
} from '../admin-metrics/history'
import type { MinuteDelta } from '../admin-metrics/recorder'
import type { RouteFamily } from '../admin-metrics/contracts'

/**
 * Reads and writes `service_metric_buckets` (plan 57, Admin track).
 *
 * Three roles, three functions, and the split is not decoration:
 *
 * - **`flushServiceMetrics`** runs as `builderhunt_app`, because the counters live in the app process.
 *   Its write is an *additive* upsert, which is the only shape that is correct when a flush lands
 *   mid-minute and another arrives for the same minute later.
 * - **`readServiceMetricWindow`** runs as `builderhunt_platform`, the role the metrics page holds.
 * - **`runServiceMetricRetention`** runs as `builderhunt_worker`, the only role granted DELETE. Forgetting
 *   a minute is a different privilege from writing one.
 */

/** Thirty days. Long enough for a month-over-month read, short enough to stay bounded without partitions. */
export const SERVICE_METRIC_RETENTION_DAYS = 30

/**
 * Writes each complete minute, adding to whatever is already there.
 *
 * `requests = requests + excluded.requests` rather than `= excluded.requests`. A flush lands whenever the
 * timer fires, so two flushes can carry parts of the same minute — and with `SET` the second would erase
 * the first. Addition also makes a retried flush safe to *lose* rather than safe to repeat, which is why
 * the caller restores its buffer on failure instead of retrying blind.
 *
 * The histogram is summed in SQL for the same reason, elementwise over the JSON array.
 */
export async function flushServiceMetrics(
  deltas: readonly MinuteDelta[],
  identity: { instance: string; deployment: string },
): Promise<{ written: number }> {
  if (deltas.length === 0) return { written: 0 }

  for (const delta of deltas) {
    if (delta.latencyBuckets.length !== LATENCY_SLOTS) {
      throw new Error(
        `refusing to write a histogram with ${delta.latencyBuckets.length} slots, expected ${LATENCY_SLOTS}`,
      )
    }
  }

  await runtimeDb
    .insert(serviceMetricBuckets)
    .values(
      deltas.map((delta) => ({
        bucketStart: delta.bucketStart,
        routeFamily: delta.routeFamily,
        instance: identity.instance,
        deployment: identity.deployment,
        requests: delta.requests,
        errors: delta.errors,
        searches: delta.searches,
        searchCacheHits: delta.searchCacheHits,
        latencyBuckets: delta.latencyBuckets,
      })),
    )
    .onConflictDoUpdate({
      target: [serviceMetricBuckets.bucketStart, serviceMetricBuckets.routeFamily, serviceMetricBuckets.instance],
      set: {
        requests: sql`${serviceMetricBuckets.requests} + excluded.requests`,
        errors: sql`${serviceMetricBuckets.errors} + excluded.errors`,
        searches: sql`${serviceMetricBuckets.searches} + excluded.searches`,
        searchCacheHits: sql`${serviceMetricBuckets.searchCacheHits} + excluded.search_cache_hits`,
        /**
         * Elementwise sum of two JSON arrays, in SQL.
         *
         * Read-modify-write in the application would race two instances flushing the same minute: both
         * would read the same array and the second write would lose the first's counts. Doing it in the
         * statement makes the row's own lock the serialisation point.
         */
        latencyBuckets: sql`(
          select coalesce(jsonb_agg(coalesce(a.value::int, 0) + coalesce(b.value::int, 0) order by a.ordinality), '[]'::jsonb)
          from jsonb_array_elements(${serviceMetricBuckets.latencyBuckets}) with ordinality a(value, ordinality)
          full join jsonb_array_elements(excluded.latency_buckets) with ordinality b(value, ordinality)
            on a.ordinality = b.ordinality
        )`,
      },
    })

  return { written: deltas.length }
}

export interface FamilyWindow {
  routeFamily: RouteFamily
  requests: number
  errors: number
  searches: number
  searchCacheHits: number
  latencyBuckets: number[]
}

export interface ServiceMetricWindow {
  from: Date
  to: Date
  /** Distinct instances that contributed. More than one means the totals are a real sum, not one process. */
  instances: number
  families: FamilyWindow[]
  totals: {
    requests: number
    errors: number
    searches: number
    searchCacheHits: number
    p50Ms: number | null
    p95Ms: number | null
    p99Ms: number | null
    /** `true` when a percentile fell past the last boundary, so `null` means "slower" and not "unknown". */
    overflow: boolean
  }
}

/**
 * One window, summed across instances and families.
 *
 * Bounded by construction: the group-by is over at most fourteen families, and the window is chosen from a
 * closed set of ranges — so this returns at most fourteen rows however much traffic the period held. That
 * is why it needs no `LIMIT` and why the read-path detector does not flag it.
 */
export async function readServiceMetricWindow(from: Date, to: Date): Promise<ServiceMetricWindow> {
  // unbounded-read-ok: the group-by is over at most fourteen route families and the window comes from a
  // closed set of ranges, so this returns at most fourteen rows however much traffic the period held. A
  // LIMIT here would silently drop a family rather than bound anything.
  const rows = await platformDb
    .select({
      routeFamily: serviceMetricBuckets.routeFamily,
      requests: sql<number>`sum(${serviceMetricBuckets.requests})::int`,
      errors: sql<number>`sum(${serviceMetricBuckets.errors})::int`,
      searches: sql<number>`sum(${serviceMetricBuckets.searches})::int`,
      searchCacheHits: sql<number>`sum(${serviceMetricBuckets.searchCacheHits})::int`,
      instances: sql<number>`count(distinct ${serviceMetricBuckets.instance})::int`,
      histograms: sql<number[][]>`jsonb_agg(${serviceMetricBuckets.latencyBuckets})`,
    })
    .from(serviceMetricBuckets)
    .where(and(gte(serviceMetricBuckets.bucketStart, from), lt(serviceMetricBuckets.bucketStart, to)))
    .groupBy(serviceMetricBuckets.routeFamily)

  const families: FamilyWindow[] = []
  const everyHistogram: number[][] = []
  let instances = 0

  for (const row of rows) {
    /**
     * A family this build does not know is skipped, not coerced.
     *
     * A row can be written by a newer deployment with a longer allowlist and read by an older one during a
     * rollout. Folding it into `other` would move traffic between lines for reasons that have nothing to do
     * with traffic; skipping keeps each named family honest, and the totals below are computed from the same
     * rows so they stay consistent with what is shown.
     */
    if (!isKnownFamily(row.routeFamily)) continue

    const histograms = (row.histograms ?? []).filter((h) => Array.isArray(h) && h.length === LATENCY_SLOTS)
    const latencyBuckets = sumHistograms(histograms)
    everyHistogram.push(latencyBuckets)
    instances = Math.max(instances, Number(row.instances ?? 0))

    families.push({
      routeFamily: row.routeFamily,
      requests: Number(row.requests ?? 0),
      errors: Number(row.errors ?? 0),
      searches: Number(row.searches ?? 0),
      searchCacheHits: Number(row.searchCacheHits ?? 0),
      latencyBuckets,
    })
  }

  const combined = sumHistograms(everyHistogram)
  const p50 = percentileFrom(combined, 0.5)
  const p95 = percentileFrom(combined, 0.95)
  const p99 = percentileFrom(combined, 0.99)

  return {
    from,
    to,
    instances,
    families: families.sort((a, b) => b.requests - a.requests),
    totals: {
      requests: families.reduce((sum, f) => sum + f.requests, 0),
      errors: families.reduce((sum, f) => sum + f.errors, 0),
      searches: families.reduce((sum, f) => sum + f.searches, 0),
      searchCacheHits: families.reduce((sum, f) => sum + f.searchCacheHits, 0),
      p50Ms: p50.atMostMs,
      p95Ms: p95.atMostMs,
      p99Ms: p99.atMostMs,
      overflow: p50.overflow || p95.overflow || p99.overflow,
    },
  }
}

export interface ServiceMetricFreshness {
  /** The newest complete minute on record, or `null` when nothing has ever been written. */
  newestBucketStart: Date | null
  /** The oldest minute still retained. With the newest, this is the real span of available history. */
  oldestBucketStart: Date | null
  /** Instances that wrote a minute in the recent window. Zero means nothing is reporting *now*. */
  reportingInstances: number
}

/**
 * How current the stored history is, which is a different question from what it says.
 *
 * The Data Freshness widget exists because every other number on the page is undated in the reader's mind:
 * an operator sees "requests: 1,204" and takes it to mean now. If the flush stopped an hour ago the figure is
 * real, correctly windowed, and describes an hour ago — and nothing on the page would say so. `generatedAt`
 * only says when the *query* ran.
 *
 * Three facts, and each answers a distinct failure. A newest bucket well behind the clock means the flush is
 * broken. An oldest bucket younger than the asked-for range means the window is longer than the history, so a
 * "30d" chart is not thirty days. Zero reporting instances means nothing is writing at all, which is the
 * state that otherwise looks exactly like no traffic.
 */
export async function readServiceMetricFreshness(now: Date = new Date()): Promise<ServiceMetricFreshness> {
  const recentSince = new Date(now.getTime() - 10 * 60 * 1000)
  // unbounded-read-ok: three aggregates over the whole table with no group-by, so this returns exactly one
  // row by construction. A LIMIT would bound nothing.
  const [row] = await platformDb
    .select({
      newest: sql<string | null>`max(${serviceMetricBuckets.bucketStart})`,
      oldest: sql<string | null>`min(${serviceMetricBuckets.bucketStart})`,
      /**
       * Two things this one line gets wrong if written the obvious way, both found by an e2e failure rather
       * than by review — and both fail *quietly*, because the caller catches and the section reports
       * `unavailable: 'error'`, which on screen is indistinguishable from a source that has no data.
       *
       * 1. **The cast wraps the whole aggregate, parentheses included.** Without them `::int` binds to the
       *    last thing inside `filter`, so the predicate becomes `bucket_start >= $1::int` — a timestamptz
       *    compared to an integer. Same trap as the load monitor's `count(*) filter (…)`.
       * 2. **The bound is an ISO string with an explicit cast, not a `Date`.** A `Date` interpolated into a
       *    raw `sql` fragment throws `ERR_INVALID_ARG_TYPE` before it reaches Postgres: drizzle maps a `Date`
       *    correctly when it is compared against a typed column (`gte(bucketStart, from)` in the query above
       *    works), but a raw fragment carries no column type for it to use.
       */
      reporting: sql<number>`(count(distinct ${serviceMetricBuckets.instance}) filter (where ${serviceMetricBuckets.bucketStart} >= ${recentSince.toISOString()}::timestamptz))::int`,
    })
    .from(serviceMetricBuckets)

  return {
    newestBucketStart: row?.newest ? new Date(row.newest) : null,
    oldestBucketStart: row?.oldest ? new Date(row.oldest) : null,
    reportingInstances: Number(row?.reporting ?? 0),
  }
}

/**
 * Deletes minutes past the retention horizon.
 *
 * `builderhunt_worker` is the only role with DELETE, which is deliberate: an application bug cannot erase
 * the history it is being measured against. Bounded by the same leading-column index the reads use.
 */
export async function runServiceMetricRetention(
  now: Date = new Date(),
): Promise<{ deletedCount: number; retainDays: number; ranAt: string }> {
  const horizon = new Date(now.getTime() - SERVICE_METRIC_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const deleted = await workerDb
    .delete(serviceMetricBuckets)
    .where(lt(serviceMetricBuckets.bucketStart, horizon))
    .returning({ bucketStart: serviceMetricBuckets.bucketStart })

  return {
    deletedCount: deleted.length,
    retainDays: SERVICE_METRIC_RETENTION_DAYS,
    ranAt: now.toISOString(),
  }
}
