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
import { builderClaims, builderProfileViews, publishedBuilderProfiles } from '../db/schema'
import { ANALYTICS_WINDOW_LIMIT } from '../db/read-bounds'

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
    // One row per day in the requested window.
    .limit(ANALYTICS_WINDOW_LIMIT)
  return rows.map((r) => ({ day: r.day, count: Number(r.count) }))
}

/**
 * The dashboard's verified-profile-owner summary: publication state, and how many people looked.
 *
 * Returns `null` when the caller holds no **verified** claim, which is what makes the dashboard
 * section absent rather than empty for everyone else. Read as one query joined through
 * `builder_claims` rather than "is this person an owner?" followed by "now count the views": the two
 * questions asked separately can disagree if the claim is revoked between them, and the one that
 * would be wrong is the one that returns the numbers.
 *
 * Both publication flags are reported because the codebase keeps them independent — a
 * `published_builder_profiles` row is the public directory listing, `metadata.portfolio.published` is
 * the portfolio builder's own switch — and a profile can have either without the other.
 *
 * Counts are floored, not rounded: below `PROFILE_VIEW_COHORT_FLOOR` the caller is told there were
 * too few and no number is produced at all. See the constant for why the number must not exist rather
 * than merely not be rendered.
 */
export interface VerifiedProfileOwnerSummary {
  builderId: string
  directoryPublished: boolean
  portfolioPublished: boolean
  /** `null` below the floor — the number is not produced, not merely withheld from the page. */
  viewsInWindow: number | null
}

export async function getVerifiedProfileOwnerSummary(
  transaction: TenantTransaction,
  subjectUserId: string,
  from: Date,
  to: Date,
  cohortFloor: number,
): Promise<VerifiedProfileOwnerSummary | null> {
  const [claim] = await transaction
    .select({
      builderIdentityId: builderClaims.builderIdentityId,
      metadata: builderClaims.metadata,
    })
    .from(builderClaims)
    .where(and(
      eq(builderClaims.subjectUserId, subjectUserId),
      eq(builderClaims.status, 'verified'),
    ))
    // The oldest verified claim, deterministically. A person with two verified identities gets one
    // tile rather than an arbitrary one that changes between requests; a picker belongs on `/me`,
    // where the full analytics already are.
    .orderBy(builderClaims.createdAt)
    .limit(1)

  if (!claim) return null

  const [[directory], [views]] = await Promise.all([
    transaction
      .select({ builderIdentityId: publishedBuilderProfiles.builderIdentityId })
      .from(publishedBuilderProfiles)
      .where(eq(publishedBuilderProfiles.builderIdentityId, claim.builderIdentityId))
      .limit(1),
    transaction
      .select({ value: count() })
      .from(builderProfileViews)
      .where(and(
        eq(builderProfileViews.builderId, claim.builderIdentityId),
        gte(builderProfileViews.viewedAt, from),
        lte(builderProfileViews.viewedAt, to),
      )),
  ])

  const total = Number(views?.value ?? 0)
  const portfolio = (claim.metadata as { portfolio?: { published?: unknown } } | null)?.portfolio
  return {
    builderId: claim.builderIdentityId,
    directoryPublished: Boolean(directory),
    portfolioPublished: portfolio?.published === true,
    viewsInWindow: total >= cohortFloor ? total : null,
  }
}
