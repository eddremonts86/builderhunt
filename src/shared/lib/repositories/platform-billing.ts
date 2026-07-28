import { and, count, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { randomId } from '~/lib/utils'
import { env } from '../env'
import { PLAN_SEAT_LIMITS, type PlanStatus, type PlanTier, type UserPlan } from '../billing-shared'
import { platformDb } from '../db/client'
import { authUsers, onboardingProgress, planChanges, planRequests, plans } from '../db/schema'
import { DELETED_USER_SENTINEL_ID } from './account-privacy'

/**
 * Thrown by the self-service plan-request path once the canonical Stripe billing system is live
 * (plans/phase-1/29-stripe-billing-platform/tasks.md §10 "Retire legacy billing mutations after canonical
 * cutover"). `STRIPE_BILLING_ENABLED` is the same flag that gates the real Stripe adapter itself
 * (`stripe-client.ts`) — reused here rather than inventing a second flag, since "the canonical
 * system is live" is exactly the condition this class exists to react to. Deliberately does NOT gate
 * `setPlatformUserPlan` (the operator grant path) or any read (`getPlatformUserPlan`,
 * `listPlatformUsersWithPlans`, `listPlatformPlanRequests`, `findPlatformPlanRequest`) — spec.md's
 * "preserve an audited operator grant path separate from paid Stripe state" and "keep historical
 * reads" both require those to keep working unconditionally.
 */
export class LegacyPlanMutationDisabledError extends Error {
  constructor() {
    super('Self-service plan requests are no longer accepted — subscribe through Checkout instead.')
    this.name = 'LegacyPlanMutationDisabledError'
  }
}

/** Pure decision, exported for direct unit testing — `env` is a frozen singleton read at import time and is never mocked in this codebase's tests (see `stripe-provider.test.ts`'s own note on this), so the actual gate logic is kept testable independent of reading it. */
export function shouldBlockLegacyPlanMutations(billingEnabledFlag: string): boolean {
  return billingEnabledFlag === 'true'
}

function assertLegacyPlanMutationsEnabled(): void {
  if (shouldBlockLegacyPlanMutations(env.STRIPE_BILLING_ENABLED)) throw new LegacyPlanMutationDisabledError()
}

export async function getPlatformUserPlan(userId: string | null | undefined): Promise<UserPlan | null> {
  if (!userId) return null
  const [row] = await platformDb.select().from(plans).where(eq(plans.userId, userId)).limit(1)
  if (!row) {
    await platformDb.insert(plans).values({ userId, plan: 'free', status: 'active' }).onConflictDoNothing()
    return { userId, plan: 'free', status: 'active', planEndsAt: null, trialEndsAt: null, notes: null }
  }
  return {
    userId: row.userId,
    plan: row.plan as PlanTier,
    status: row.status as PlanStatus,
    planEndsAt: row.planEndsAt?.toISOString() ?? null,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    notes: row.notes,
  }
}

export async function setPlatformUserPlan(
  userId: string,
  newPlan: PlanTier,
  changedBy: string,
  reason?: string,
  planEndsAt?: Date,
) {
  const from = (await getPlatformUserPlan(userId))?.plan ?? 'free'

  // A personal organization can carry real seats above its own tier's usual
  // limit (an admin grant can raise `seat_limit` independent of `tier` — see
  // 0022's sync function) — so shrinking the tier back down must not be
  // allowed to silently strand members over the new, smaller limit. Checked
  // via authDb (organization-lifecycle.ts), not platformDb: this connection's
  // role has no grant on organization_members, by design (least privilege).
  const { personalOrganizationId } = await import('../migration/backfill')
  const { assertSeatLimitDowngradeIsSafe } = await import('../auth/organization-lifecycle')
  await assertSeatLimitDowngradeIsSafe(personalOrganizationId(userId), PLAN_SEAT_LIMITS[newPlan])

  await platformDb.transaction(async (tx) => {
    await tx.insert(plans).values({ userId, plan: newPlan, status: 'active', planEndsAt: planEndsAt ?? null })
      .onConflictDoUpdate({
        target: plans.userId,
        set: { plan: newPlan, status: 'active', planEndsAt: planEndsAt ?? null, updatedAt: new Date() },
      })
    await tx.insert(planChanges).values({ id: randomId(), userId, fromPlan: from, toPlan: newPlan, changedBy, reason: reason ?? null })
    // Keeps the user's personal organization's `organization_entitlements` row
    // — the table every actual feature/seat-limit check reads — in sync with
    // this admin grant. Without this, the two only ever matched by
    // coincidence (see 0022's migration comment); this is the only ongoing
    // writer, via a SECURITY DEFINER function since builderhunt_platform has
    // no direct grant on organization_entitlements.
    await tx.execute(sql`
      select sync_personal_organization_entitlement(
        ${userId}, ${newPlan}, 'active', ${PLAN_SEAT_LIMITS[newPlan]}, ${planEndsAt?.toISOString() ?? null}
      )
    `)
  })
  return { from, to: newPlan }
}

export async function requestPlatformPlanUpgrade(userId: string, requestedPlan: 'pro' | 'team', message?: string) {
  assertLegacyPlanMutationsEnabled()
  const [existing] = await platformDb.select({ id: planRequests.id }).from(planRequests)
    .where(and(eq(planRequests.userId, userId), eq(planRequests.status, 'pending'))).limit(1)
  if (existing) return { id: existing.id, alreadyPending: true }
  const id = randomId()
  await platformDb.insert(planRequests).values({ id, userId, requestedPlan, message: message ?? null })
  return { id, alreadyPending: false }
}

export async function resolvePlatformPlanRequest(id: string, status: 'approved' | 'declined') {
  assertLegacyPlanMutationsEnabled()
  await platformDb.update(planRequests).set({ status }).where(eq(planRequests.id, id))
}

export async function findPlatformPlanRequest(id: string) {
  const [row] = await platformDb.select().from(planRequests).where(eq(planRequests.id, id)).limit(1)
  return row ?? null
}

export async function listPlatformUsersWithPlans() {
  const rows = await platformDb.select({
    userId: authUsers.id,
    name: authUsers.name,
    email: authUsers.email,
    createdAt: authUsers.createdAt,
    plan: plans.plan,
    status: plans.status,
    planEndsAt: plans.planEndsAt,
  }).from(authUsers).leftJoin(plans, eq(plans.userId, authUsers.id)).orderBy(desc(authUsers.createdAt))
  return rows.map((row) => ({
    ...row,
    plan: (row.plan ?? 'free') as PlanTier,
    status: row.status ?? 'active',
    createdAt: row.createdAt.toISOString(),
    planEndsAt: row.planEndsAt?.toISOString() ?? null,
  }))
}

export function listPlatformPlanRequests() {
  return platformDb.select({
    id: planRequests.id,
    userId: planRequests.userId,
    requestedPlan: planRequests.requestedPlan,
    status: planRequests.status,
    message: planRequests.message,
    createdAt: planRequests.createdAt,
    userName: authUsers.name,
    userEmail: authUsers.email,
  }).from(planRequests).leftJoin(authUsers, eq(authUsers.id, planRequests.userId))
    .orderBy(desc(planRequests.createdAt)).limit(200)
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
