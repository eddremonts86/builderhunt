// Server-only billing helpers. Importable from server contexts (loaders,
// route server handlers, admin pages). The client side should import
// billing-shared.ts for types and constants.

import { db } from '~/shared/lib/db/index'
import { plans, planChanges, planRequests, savedQueries, builderNotes, authUsers } from '~/shared/lib/db/schema'
import { eq, count, and, desc } from 'drizzle-orm'
import { randomId } from '~/lib/utils'
import type { PlanTier, PlanStatus, UserPlan, LimitResource, LimitCheck } from './billing-shared'
export { PLAN_LIMITS, PLAN_PRICING, type PlanTier, type PlanStatus, type UserPlan, type LimitResource, type LimitCheck } from './billing-shared'

export async function getUserPlan(userId: string | null | undefined): Promise<UserPlan | null> {
  if (!userId) return null
  const [row] = await db.select().from(plans).where(eq(plans.userId, userId)).limit(1)
  if (!row) {
    await db.insert(plans).values({ userId, plan: 'free', status: 'active' }).onConflictDoNothing()
    return {
      userId,
      plan: 'free',
      status: 'active',
      planEndsAt: null,
      trialEndsAt: null,
      notes: null,
    }
  }
  return {
    userId: row.userId,
    plan: row.plan as PlanTier,
    status: row.status as PlanStatus,
    planEndsAt: row.planEndsAt ? row.planEndsAt.toISOString() : null,
    trialEndsAt: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
    notes: row.notes,
  }
}

export async function setUserPlan(
  userId: string,
  newPlan: PlanTier,
  changedBy: string,
  reason?: string,
  planEndsAt?: Date,
): Promise<{ from: PlanTier; to: PlanTier }> {
  const current = await getUserPlan(userId)
  const from = current?.plan ?? 'free'
  await db
    .insert(plans)
    .values({
      userId,
      plan: newPlan,
      status: 'active',
      planEndsAt: planEndsAt ?? null,
    })
    .onConflictDoUpdate({
      target: plans.userId,
      set: {
        plan: newPlan,
        status: 'active',
        planEndsAt: planEndsAt ?? null,
        updatedAt: new Date(),
      },
    })
  await db.insert(planChanges).values({
    id: randomId(),
    userId,
    fromPlan: from,
    toPlan: newPlan,
    changedBy,
    reason: reason ?? null,
  })
  return { from, to: newPlan }
}

export async function requestPlanUpgrade(
  userId: string,
  requestedPlan: 'pro' | 'team',
  message?: string,
): Promise<{ id: string; alreadyPending: boolean }> {
  const [existing] = await db
    .select()
    .from(planRequests)
    .where(and(eq(planRequests.userId, userId), eq(planRequests.status, 'pending')))
    .limit(1)
  if (existing) {
    return { id: existing.id, alreadyPending: true }
  }
  const id = randomId()
  await db.insert(planRequests).values({
    id,
    userId,
    requestedPlan,
    message: message ?? null,
  })
  return { id, alreadyPending: false }
}

export async function resolvePlanRequest(
  id: string,
  status: 'approved' | 'declined',
): Promise<void> {
  await db
    .update(planRequests)
    .set({ status })
    .where(eq(planRequests.id, id))
}

export async function checkLimit(userId: string, resource: LimitResource): Promise<LimitCheck> {
  const plan = (await getUserPlan(userId))?.plan ?? 'free'
  const limits = PLAN_LIMITS[plan]
  const limit = limits[resource]
  let current = 0
  if (resource === 'savedSearches') {
    const [r] = await db.select({ c: count() }).from(savedQueries).where(eq(savedQueries.userId, userId))
    current = Number(r?.c ?? 0)
  } else if (resource === 'savedBuilders') {
    const [r] = await db.select({ c: count() }).from(builderNotes).where(eq(builderNotes.userId, userId))
    current = Number(r?.c ?? 0)
  } else if (resource === 'rssSubscriptions') {
    const [r] = await db.select({ c: count() }).from(savedQueries).where(eq(savedQueries.userId, userId))
    current = Number(r?.c ?? 0)
  }
  return { allowed: current < limit, current, limit, plan, resource }
}

export async function listAllUsersWithPlans() {
  const rows = await db
    .select({
      userId: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      createdAt: authUsers.createdAt,
      plan: plans.plan,
      status: plans.status,
      planEndsAt: plans.planEndsAt,
    })
    .from(authUsers)
    .leftJoin(plans, eq(plans.userId, authUsers.id))
    .orderBy(desc(authUsers.createdAt))
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    plan: (r.plan ?? 'free') as PlanTier,
    status: r.status ?? 'active',
    planEndsAt: r.planEndsAt instanceof Date ? r.planEndsAt.toISOString() : r.planEndsAt,
  }))
}

export async function listPlanRequestsWithUsers() {
  const rows = await db
    .select({
      id: planRequests.id,
      userId: planRequests.userId,
      requestedPlan: planRequests.requestedPlan,
      status: planRequests.status,
      message: planRequests.message,
      createdAt: planRequests.createdAt,
      userName: authUsers.name,
      userEmail: authUsers.email,
    })
    .from(planRequests)
    .leftJoin(authUsers, eq(authUsers.id, planRequests.userId))
    .orderBy(desc(planRequests.createdAt))
    .limit(200)
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    requestedPlan: r.requestedPlan as 'pro' | 'team',
    status: r.status as 'pending' | 'approved' | 'declined',
    message: r.message,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    userName: r.userName,
    userEmail: r.userEmail,
  }))
}
