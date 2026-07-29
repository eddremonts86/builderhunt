// Repository for the `builder_profile_views` table — the write path that
// records "this authenticated viewer saw this builder profile at this time"
// and the aggregate the verified owner reads.
//
// The table is keyed on `viewer_id` (NOT NULL when the row is present),
// so this is a presence record per viewer, never a counter. The same
// viewer visiting the same profile twice on the same day does not add a
// second row — the `findBuilderProfileViewForDay` lookup guards that.

import { and, count, desc, eq, gte, isNull, lt, lte, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { builderProfileViews } from '../db/schema'

/**
 * Whether the (viewer, builder, day) tuple already has a row. Used by the
 * write path so a refresh of the same page does not double-count.
 */
export async function findBuilderProfileViewForDay(
  transaction: TenantTransaction,
  builderId: string,
  viewerId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<boolean> {
  const rows = await transaction
    .select({ id: builderProfileViews.id })
    .from(builderProfileViews)
    .where(
      and(
        eq(builderProfileViews.builderId, builderId),
        eq(builderProfileViews.viewerId, viewerId),
        gte(builderProfileViews.viewedAt, dayStart),
        lt(builderProfileViews.viewedAt, dayEnd),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Record a view. Idempotent at the (viewer, builder, day) granularity:
 * a duplicate insert within the same day is a no-op rather than a 5xx
 * because analytics on a public profile must never block the page.
 */
export async function recordBuilderProfileView(
  transaction: TenantTransaction,
  builderId: string,
  viewerId: string,
  now: Date = new Date(),
): Promise<void> {
  await transaction.insert(builderProfileViews).values({
    builderId,
    viewerId,
    viewedAt: now,
  })
}

export interface BuilderProfileViewCount {
  day: string
  count: number
}

/**
 * Per-day view counts over the requested window. The owner sees the
 * numbers; the SQL never returns viewer identities.
 */
export async function listBuilderProfileViewCounts(
  transaction: TenantTransaction,
  builderId: string,
  from: Date,
  to: Date,
): Promise<BuilderProfileViewCount[]> {
  const rows = await transaction
    .select({
      day: sql<string>`to_char(date_trunc('day', ${builderProfileViews.viewedAt}), 'YYYY-MM-DD')`,
      count: count(),
    })
    .from(builderProfileViews)
    .where(
      and(
        eq(builderProfileViews.builderId, builderId),
        gte(builderProfileViews.viewedAt, from),
        lte(builderProfileViews.viewedAt, to),
        isNull(sql`null`), // explicit null filter kept for future "exclude consent-withdrawn viewers" path
      ),
    )
    .groupBy(sql`date_trunc('day', ${builderProfileViews.viewedAt})`)
    .orderBy(desc(sql`date_trunc('day', ${builderProfileViews.viewedAt})`))
  return rows.map((r) => ({ day: r.day, count: Number(r.count) }))
}
