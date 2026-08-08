import { and, count, eq, gte, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { alertTriggers, builderIdentities, organizationBuilders, savedQueries } from '../db/schema'
import type {
  DashboardRange,
  DashboardRecency,
  DashboardSourceCoverage,
  DashboardSummary,
} from '../dashboard/contracts'
import { DASHBOARD_ROW_LIMITS } from '../dashboard/contracts'

/**
 * Tenant-scoped aggregates for `GET /api/dashboard/overview` (plans/ui-dashboard Wave 1, "Build
 * bounded dashboard aggregate repositories").
 *
 * ## Three rules every function here follows
 *
 * **One clock for the whole response.** Each function takes `now` rather than calling `new Date()`.
 * A projection assembled from four queries that each read their own clock can report a builder as
 * both "newly tracked in the last 7 days" and outside the recency window, and the discrepancy
 * appears only under load — the exact bug class that is impossible to reproduce and expensive to
 * find. It also makes every function directly testable.
 *
 * **UTC, stated.** Day bucketing uses `at time zone 'UTC'` on both sides of the comparison. The
 * dashboard's previous chart truncated in the session TimeZone while building its keys in UTC, so on
 * any non-UTC server a day's count landed in no bucket at all. The contract carries
 * `timezone: 'UTC'` for the same reason: a boundary rule that is not stated will be assumed, and
 * assumed wrongly.
 *
 * **Bounded and ordered.** Every list query has a `LIMIT` matching the contract's row cap and an
 * ordering that is total. An aggregate with a partial ordering returns a different top-N on a
 * different query plan, which reads to a user as data changing on its own.
 */

/** Days each range covers. The recency chart draws one bucket per day, capped by the contract. */
export const RANGE_DAYS: Record<DashboardRange, number> = { '24h': 1, '7d': 7, '30d': 30 }

/** Start of the window, as an instant. Exported so the route and the tests share one definition. */
export function rangeStart(now: Date, range: DashboardRange): Date {
  return new Date(now.getTime() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000)
}

/**
 * The four headline counts.
 *
 * `newlyTrackedInRange` reads `organization_builders.created_at` — when *this workspace* started
 * following the person — while `seenActiveInRange` reads `builder_identities.last_seen_at`, which is
 * global to the identity. They answer different questions and are deliberately not derived from one
 * another: a builder tracked today may have been last seen a month ago, and a builder tracked last
 * year may have been seen this morning.
 */
export async function getDashboardSummary(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date,
  range: DashboardRange,
): Promise<DashboardSummary> {
  const since = rangeStart(now, range)

  const [[tracked], [seenActive], [newlyTracked], [searches]] = await Promise.all([
    transaction.select({ value: count() }).from(organizationBuilders)
      .where(eq(organizationBuilders.organizationId, organizationId)),
    transaction.select({ value: count() }).from(organizationBuilders)
      .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
      .where(and(
        eq(organizationBuilders.organizationId, organizationId),
        gte(builderIdentities.lastSeenAt, since),
      )),
    transaction.select({ value: count() }).from(organizationBuilders)
      .where(and(
        eq(organizationBuilders.organizationId, organizationId),
        gte(organizationBuilders.createdAt, since),
      )),
    transaction.select({ value: count() }).from(savedQueries)
      .where(eq(savedQueries.organizationId, organizationId)),
  ])

  return {
    trackedBuilders: Number(tracked?.value ?? 0),
    seenActiveInRange: Number(seenActive?.value ?? 0),
    newlyTrackedInRange: Number(newlyTracked?.value ?? 0),
    savedSearches: Number(searches?.value ?? 0),
  }
}

/**
 * Tracked builders by the UTC day a source last saw them.
 *
 * A recency histogram: `last_seen_at` is one timestamp per identity, so each tracked builder falls
 * in exactly one bucket and the buckets sum to `seenActiveInRange`. It is emphatically not a time
 * series of events, and the widget that renders it says so.
 *
 * Empty days are filled here rather than in the client. A chart that omits them silently compresses
 * a quiet week into a busy-looking one.
 */
export async function getDashboardRecency(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date,
  range: DashboardRange,
): Promise<DashboardRecency> {
  const days = Math.min(RANGE_DAYS[range], DASHBOARD_ROW_LIMITS.recencyBuckets)
  const since = rangeStart(now, range)

  const rows = await transaction.select({
    day: sql<string>`to_char(date_trunc('day', ${builderIdentities.lastSeenAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
    value: sql<number>`count(*)::int`,
  }).from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      gte(builderIdentities.lastSeenAt, since),
    ))
    .groupBy(sql`date_trunc('day', ${builderIdentities.lastSeenAt} at time zone 'UTC')`)
    // One row per UTC day in the window, and `days` is that window's own length — the same number
    // `fillDays` pads the result to, so the ceiling cannot cut a bucket the chart then draws as zero.
    .limit(days)

  return { buckets: fillDays(rows, now, days), timezone: 'UTC' }
}

/**
 * Turns grouped rows into one bucket per day of the window, zeros included.
 *
 * Shared by all three day-bucketed charts so they cannot disagree about the boundary rule. Empty days
 * are filled here rather than in the client: a chart that omits them silently compresses a quiet week
 * into a busy-looking one.
 *
 * `Date.UTC` arithmetic, not `setDate`, which mutates in local time — west of UTC that produces the
 * same ISO key twice and drops another day entirely.
 */
function fillDays(
  rows: ReadonlyArray<{ day: string; value: number }>,
  now: Date,
  days: number,
): Array<{ date: string; count: number }> {
  const counts = new Map(rows.map((row) => [row.day, Number(row.value)]))
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - (days - 1 - index),
    ))
    const key = date.toISOString().slice(0, 10)
    return { date: key, count: counts.get(key) ?? 0 }
  })
}

/**
 * Builders this workspace started tracking, by UTC day.
 *
 * The counterpart to `getDashboardRecency`, and the two answer genuinely different questions that a
 * reader will confuse if either is mislabelled: recency buckets *everyone tracked* by when a source
 * last saw them, so its bars sum to the tracked roster; this buckets *new arrivals* by when this
 * workspace added them, so its bars sum to `newlyTrackedInRange`. One is a distribution, the other
 * is a rate.
 *
 * No quality or conversion is implied and the copy must not imply one: `organization_builders` records
 * that somebody pressed Track, not that a hire followed.
 */
export async function getDashboardDiscoveryTrend(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date,
  range: DashboardRange,
): Promise<DashboardRecency> {
  const days = Math.min(RANGE_DAYS[range], DASHBOARD_ROW_LIMITS.recencyBuckets)
  const since = rangeStart(now, range)

  const rows = await transaction.select({
    day: sql<string>`to_char(date_trunc('day', ${organizationBuilders.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
    value: sql<number>`count(*)::int`,
  }).from(organizationBuilders)
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      gte(organizationBuilders.createdAt, since),
    ))
    .groupBy(sql`date_trunc('day', ${organizationBuilders.createdAt} at time zone 'UTC')`)
    // One row per UTC day in the window, and `days` is that window's own length — the same number
    // `fillDays` pads the result to, so the ceiling cannot cut a bucket the chart then draws as zero.
    .limit(days)

  return { buckets: fillDays(rows, now, days), timezone: 'UTC' }
}

/**
 * Alert triggers by UTC day.
 *
 * Counted from `matched_at`, never filtered by `read_at`: **acknowledging a trigger does not unmake
 * it.** A volume chart that shrank as someone worked through their inbox would answer "what have I
 * not read" while looking like it answers "how much fired", and the two diverge exactly when the
 * chart matters.
 */
export async function getDashboardAlertVolume(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date,
  range: DashboardRange,
): Promise<DashboardRecency> {
  const days = Math.min(RANGE_DAYS[range], DASHBOARD_ROW_LIMITS.recencyBuckets)
  const since = rangeStart(now, range)

  const rows = await transaction.select({
    day: sql<string>`to_char(date_trunc('day', ${alertTriggers.matchedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
    value: sql<number>`count(*)::int`,
  }).from(alertTriggers)
    .where(and(
      eq(alertTriggers.organizationId, organizationId),
      gte(alertTriggers.matchedAt, since),
    ))
    .groupBy(sql`date_trunc('day', ${alertTriggers.matchedAt} at time zone 'UTC')`)
    // One row per UTC day in the window, and `days` is that window's own length — the same number
    // `fillDays` pads the result to, so the ceiling cannot cut a bucket the chart then draws as zero.
    .limit(days)

  return { buckets: fillDays(rows, now, days), timezone: 'UTC' }
}

/**
 * Which platforms the workspace's tracked builders come from — **all of them**, not a recent sample.
 *
 * That is the whole difference from the existing Source mix widget, which counts the most recent page
 * of tracked builders and therefore answers "what did we add lately" while appearing to answer "where
 * does our pipeline come from". A workspace with 400 builders from six sources and 20 recent GitHub
 * adds reads as 100% GitHub under the sample.
 *
 * Ordered by count then source name so the ordering is total: ties would otherwise reshuffle between
 * query plans and read as data changing on its own.
 */
export async function getDashboardSourceCoverage(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<DashboardSourceCoverage> {
  const rows = await transaction.select({
    source: builderIdentities.source,
    value: sql<number>`count(*)::int`,
  }).from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(eq(organizationBuilders.organizationId, organizationId))
    .groupBy(builderIdentities.source)
    .orderBy(sql`count(*) desc`, builderIdentities.source)
    .limit(DASHBOARD_ROW_LIMITS.sourceCoverage)

  const sources = rows.map((row) => ({ source: row.source, count: Number(row.value) }))
  return {
    sources,
    /*
     * Summed from the same rows rather than counted separately, so the denominator and the parts
     * always agree. A second `count(*)` could disagree with these under concurrent tracking, and a
     * percentage that does not sum to 100 is the kind of defect nobody reports and everybody notices.
     * The `LIMIT` is above the number of sources this product has, so it cannot silently drop one;
     * if it ever did, the total would be short and the contract's cap would surface it.
     */
    totalTracked: sources.reduce((sum, row) => sum + row.count, 0),
  }
}
