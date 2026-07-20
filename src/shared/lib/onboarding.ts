/**
 * Onboarding state machine.
 *
 * Steps: 0 (not started) → 1 (welcome seen) → 2 (first search) → 3 (saved 3+ builders, completed)
 *
 * Tenant-scoped library: every call receives a `TenantTransaction` from
 * `withTenantContext` so reads/writes run under the caller's RLS-scoped
 * connection settings instead of a global unscoped `db` handle.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { builders, onboardingProgress, savedQueries } from '~/shared/lib/db/schema'

export const STARTER_QUERIES = [
  'rust async runtime',
  'indie hackers in EU',
  'AI agents in production',
  'react performance',
  'python ML engineers',
] as const

export const TOTAL_STEPS = 3

export interface OnboardingStatus {
  step: number
  completed: boolean
  skipped: boolean
  skippedCount: number
  firstQueryId: string | null
  firstBuilderIds: string[]
  eligible: boolean
  reason?: string
}

const ONBOARDING_WINDOW_DAYS = 7
const MAX_SKIPS = 3

export async function getOnboardingStatus(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
): Promise<OnboardingStatus> {
  const [row] = await transaction
    .select()
    .from(onboardingProgress)
    .where(and(eq(onboardingProgress.userId, userId), eq(onboardingProgress.organizationId, organizationId)))
    .limit(1)

  if (!row) {
    return {
      step: 0,
      completed: false,
      skipped: false,
      skippedCount: 0,
      firstQueryId: null,
      firstBuilderIds: [],
      eligible: await isEligibleForOnboarding(transaction, userId, null),
    }
  }

  return {
    step: row.step,
    completed: row.completed,
    skipped: row.skipped,
    skippedCount: row.skippedCount,
    firstQueryId: row.firstQueryId,
    firstBuilderIds: row.firstBuilderIds ?? [],
    eligible: await isEligibleForOnboarding(transaction, userId, row),
  }
}

async function isEligibleForOnboarding(
  transaction: TenantTransaction,
  userId: string,
  row: { completed: boolean; skippedCount: number; createdAt: Date } | null,
): Promise<boolean> {
  if (row?.completed) return false
  if (row && row.skippedCount >= MAX_SKIPS) return false
  if (row) {
    const windowMs = ONBOARDING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    if (Date.now() - row.createdAt.getTime() > windowMs) return false
  }

  const [{ count: searches }] = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(savedQueries)
    .where(eq(savedQueries.userId, userId))
  const [{ count: saved }] = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(builders)
    .where(eq(builders.userId, userId))

  if (searches > 0 || saved >= 5) {
    return false
  }

  return true
}

export async function ensureOnboardingRow(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
): Promise<void> {
  await transaction
    .insert(onboardingProgress)
    .values({ userId, organizationId, step: 0 })
    .onConflictDoNothing()
}

export async function advanceOnboarding(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  patch: { step?: number; firstQueryId?: string; addBuilderId?: string; completed?: boolean },
): Promise<OnboardingStatus> {
  await ensureOnboardingRow(transaction, organizationId, userId)

  const update: Record<string, unknown> = { updatedAt: new Date() }

  if (patch.step !== undefined) update.step = Math.max(patch.step, 0)
  if (patch.firstQueryId !== undefined) update.firstQueryId = patch.firstQueryId
  if (patch.completed) {
    update.completed = true
    update.completedAt = new Date()
  }

  if (patch.addBuilderId) {
    update.firstBuilderIds = sql`COALESCE(${onboardingProgress.firstBuilderIds}, '[]'::jsonb) || ${JSON.stringify([patch.addBuilderId])}::jsonb`
  }

  await transaction
    .update(onboardingProgress)
    .set(update)
    .where(and(eq(onboardingProgress.userId, userId), eq(onboardingProgress.organizationId, organizationId)))
  return getOnboardingStatus(transaction, organizationId, userId)
}

export async function skipOnboarding(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
): Promise<OnboardingStatus> {
  await ensureOnboardingRow(transaction, organizationId, userId)
  await transaction
    .update(onboardingProgress)
    .set({
      skipped: true,
      skippedCount: sql`${onboardingProgress.skippedCount} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(onboardingProgress.userId, userId), eq(onboardingProgress.organizationId, organizationId)))
  return getOnboardingStatus(transaction, organizationId, userId)
}
