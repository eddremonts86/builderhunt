import { and, count, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { platformDb } from '../db/client'
import { authUsers, onboardingProgress } from '../db/schema'
import { DELETED_USER_SENTINEL_ID } from './account-privacy'

/*
 * `LegacyPlanMutationDisabledError` / `shouldBlockLegacyPlanMutations` / `assertLegacyPlanMutationsEnabled`
 * lived here and are gone (2026-08-04).
 *
 * They were a flag-driven gate (`STRIPE_BILLING_ENABLED === 'true'`) in front of the two self-service
 * plan-request mutations. Both of those entry points, their routes and the admin queue that reviewed them were
 * removed with the `plans`/`plan_requests` tables, so the gate guarded nothing: `assertLegacyPlanMutationsEnabled`
 * had no callers, and the exported error was reachable only through a re-export nobody threw.
 *
 * Kept as a note rather than deleted silently because the flag's *other* direction is documented as a kill
 * switch: `docs/operations/stripe-incident-response.md` said flipping `STRIPE_BILLING_ENABLED` back to `false`
 * would "re-open the legacy manual plan-request path". It no longer can — there is no such path. The operator
 * grant (`repositories/operator-grants.ts`, reached from `/admin/users`) is what remains, and it never consulted
 * this flag, so the kill switch's real behaviour is unchanged.
 */

/**
 * Every account, newest first — with no plan columns.
 *
 * This used to left-join the legacy per-user `plans` table and surface `plan`/`status`/`planEndsAt` alongside
 * each user. Those three fields were a second, weaker answer to a question `getPlatformUserBillingSummary`
 * already answers properly: entitlement lives on the organization, and the summary reports it together with its
 * *provenance* (Stripe-backed, manually granted, or expired). Keeping both meant the admin list could show a
 * user as `pro` from one source while the workspace they actually work in was `free`.
 *
 * `listPlatformUsersWithBilling` composes this with that summary, which is the only shape callers use.
 */
export async function listPlatformUsers() {
  const rows = await platformDb.select({
    userId: authUsers.id,
    name: authUsers.name,
    email: authUsers.email,
    createdAt: authUsers.createdAt,
  }).from(authUsers).orderBy(desc(authUsers.createdAt))
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
}

export type UserBillingProvenance = 'canonical' | 'manual_exception' | 'expired_exception' | 'no_organization'

export interface PlatformUserBillingSummary {
  organizationId: string
  organizationName: string
  /** Canonical `OrganizationTier` — includes `pro_max`, unlike the legacy `PlanTier` above. */
  entitlementTier: string
  entitlementStatus: string
  currentPeriodEnd: string | null
  trialEndsAt: string | null
  provenance: UserBillingProvenance
  /** Distinct from `provenance === 'canonical'`: a plain free-tier org is also "canonical" (free is
   * the default, not an exception) but has no subscription to speak of — this is the fact a "Stripe"
   * badge should actually gate on, not the broader provenance classification. */
  hasActiveSubscription: boolean
}

/**
 * The organization a user owns, its canonical entitlement, and whether that entitlement is backed
 * by a real Stripe subscription (`canonical`) or was granted by an admin with no matching
 * `billing_subscriptions` row (`manual_exception` / `expired_exception` once its own period has
 * passed) — plans/UI/tasks.md Wave 5 "Align Admin Users with organization-owned billing". `null`
 * means the user owns no organization at all (a real, distinguishable state — see
 * `platform_admin_user_billing_summary`'s own migration comment for why `builderhunt_platform`
 * reads this via a SECURITY DEFINER function rather than a direct table grant).
 */
export async function getPlatformUserBillingSummary(
  userId: string,
  now: Date = new Date(),
  db: Pick<typeof platformDb, 'execute'> = platformDb,
): Promise<PlatformUserBillingSummary | null> {
  const rows = await db.execute<{
    organization_id: string
    organization_name: string
    tier: string
    status: string
    current_period_end: string | null
    trial_ends_at: string | null
    has_active_subscription: boolean
  }>(sql`select * from platform_admin_user_billing_summary(${userId})`)
  const row = rows[0]
  if (!row) return null

  // A raw `.execute(sql...)` call bypasses drizzle's column-aware result mapping — postgres-js
  // hands back timestamptz columns from a plain function call as strings, not `Date` instances (the
  // typed `.select()` API is what normally does that conversion), so both fields are parsed here.
  const currentPeriodEnd = row.current_period_end ? new Date(row.current_period_end) : null
  const trialEndsAt = row.trial_ends_at ? new Date(row.trial_ends_at) : null
  const periodPassed = (currentPeriodEnd !== null && currentPeriodEnd.getTime() < now.getTime())
    || (trialEndsAt !== null && trialEndsAt.getTime() < now.getTime())
  const provenance: UserBillingProvenance = row.has_active_subscription
    ? 'canonical'
    : row.tier === 'free'
      ? 'canonical' // free is the default state, not an "exception" of anything
      : periodPassed
        ? 'expired_exception'
        : 'manual_exception'

  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    entitlementTier: row.tier,
    entitlementStatus: row.status,
    currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: trialEndsAt?.toISOString() ?? null,
    provenance,
    hasActiveSubscription: row.has_active_subscription,
  }
}

export interface PlatformUserWithBilling {
  userId: string
  name: string
  email: string
  createdAt: string
  /**
   * The canonical entitlement of the organization this user owns, or `null` when they own none.
   *
   * `plan`, `status` and `planEndsAt` used to sit alongside it, read from the legacy per-user `plans` table.
   * They are gone: two sources for one question meant the list could show a user as `pro` while the workspace
   * they actually work in was `free`, and only one of those could be acted on. Whatever the UI needs — tier,
   * status, period end, whether Stripe is behind it — is inside `billing`, together with the provenance that
   * says which of those it is.
   */
  billing: PlatformUserBillingSummary | null
}

/** `listPlatformUsersWithPlans` plus each user's owning-organization billing summary — one function
 * call per user (bounded by the admin page's own page size, same shape as `listLatestJobRuns`'s
 * per-key fan-out), since the underlying read is a SECURITY DEFINER function call, not a joinable
 * table this connection has a grant on. */
export async function listPlatformUsersWithBilling(): Promise<PlatformUserWithBilling[]> {
  const users = await listPlatformUsers()
  const now = new Date()
  const billing = await Promise.all(users.map((u) => getPlatformUserBillingSummary(u.userId, now)))
  return users.map((u, i) => ({ ...u, billing: billing[i] ?? null }))
}

export async function getPlatformAccountMetrics(oneDayAgo: Date, oneWeekAgo: Date) {
  // Excludes DELETED_USER_SENTINEL_ID (drizzle/0026_deleted_user_sentinel.sql)
  // — a permanent system row, not a real account, that would otherwise
  // permanently inflate totalUsers by one.
  const notSentinel = ne(authUsers.id, DELETED_USER_SENTINEL_ID)
  const [[total], [daily], [weekly]] = await Promise.all([
    platformDb.select({ value: count() }).from(authUsers).where(notSentinel),
    platformDb.select({ value: count() }).from(authUsers).where(and(notSentinel, gte(authUsers.createdAt, oneDayAgo))),
    platformDb.select({ value: count() }).from(authUsers).where(and(notSentinel, gte(authUsers.createdAt, oneWeekAgo))),
  ])
  return {
    totalUsers: Number(total?.value ?? 0),
    newUsersLast24h: Number(daily?.value ?? 0),
    newUsersLast7d: Number(weekly?.value ?? 0),
  }
}

/**
 * onboarding-flow plan, "Add activation metrics to the admin metrics endpoint" — needs
 * `builderhunt_platform`'s new unscoped SELECT policy on `onboarding_progress`
 * (0049_onboarding_progress_platform_read.sql), since that table's RLS was previously
 * `builderhunt_app`-only, scoped per-organization.
 */
export async function getOnboardingActivationMetrics(oneWeekAgo: Date) {
  const [[completedTotal], [skippedTotal], [completedLast7d]] = await Promise.all([
    platformDb.select({ value: count() }).from(onboardingProgress).where(eq(onboardingProgress.completed, true)),
    platformDb.select({ value: count() }).from(onboardingProgress).where(eq(onboardingProgress.skipped, true)),
    platformDb.select({ value: count() }).from(onboardingProgress)
      .innerJoin(authUsers, eq(onboardingProgress.userId, authUsers.id))
      .where(and(eq(onboardingProgress.completed, true), gte(authUsers.createdAt, oneWeekAgo))),
  ])
  return {
    onboardingCompleted: Number(completedTotal?.value ?? 0),
    onboardingSkipped: Number(skippedTotal?.value ?? 0),
    onboardingCompletedLast7d: Number(completedLast7d?.value ?? 0),
  }
}
