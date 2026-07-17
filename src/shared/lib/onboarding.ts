/**
 * Onboarding state machine.
 *
 * Steps: 0 (not started) → 1 (welcome seen) → 2 (first search) → 3 (saved 3+ builders, completed)
 *
 * Server-only library: all DB calls are made via dynamic import of
 * `~/shared/lib/db/index` so the client bundle never imports the
 * `postgres` driver (which needs Node's `Buffer`).
 */

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

async function getDb() {
  const { db } = await import('~/shared/lib/db/index')
  const { onboardingProgress, savedQueries, builders } = await import('~/shared/lib/db/schema')
  const { eq, sql } = await import('drizzle-orm')
  return { db, onboardingProgress, savedQueries, builders, eq, sql }
}

export async function getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
  const { db, onboardingProgress, eq } = await getDb()

  const [row] = await db
    .select()
    .from(onboardingProgress)
    .where(eq(onboardingProgress.userId, userId))
    .limit(1)

  if (!row) {
    return {
      step: 0,
      completed: false,
      skipped: false,
      skippedCount: 0,
      firstQueryId: null,
      firstBuilderIds: [],
      eligible: await isEligibleForOnboarding(userId, null),
    }
  }

  return {
    step: row.step,
    completed: row.completed,
    skipped: row.skipped,
    skippedCount: row.skippedCount,
    firstQueryId: row.firstQueryId,
    firstBuilderIds: row.firstBuilderIds ?? [],
    eligible: await isEligibleForOnboarding(userId, row),
  }
}

async function isEligibleForOnboarding(
  userId: string,
  row: { completed: boolean; skippedCount: number; createdAt: Date } | null,
): Promise<boolean> {
  if (row?.completed) return false
  if (row && row.skippedCount >= MAX_SKIPS) return false
  if (row) {
    const windowMs = ONBOARDING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    if (Date.now() - row.createdAt.getTime() > windowMs) return false
  }

  const { db, savedQueries, builders, eq, sql } = await getDb()

  const [{ count: searches }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(savedQueries)
    .where(eq(savedQueries.userId, userId))
  const [{ count: saved }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(builders)
    .where(eq(builders.userId, userId))

  if (searches > 0 || saved >= 5) {
    return false
  }

  return true
}

export async function ensureOnboardingRow(userId: string): Promise<void> {
  const { db, onboardingProgress } = await getDb()
  await db
    .insert(onboardingProgress)
    .values({ userId, step: 0 })
    .onConflictDoNothing()
}

export async function advanceOnboarding(
  userId: string,
  patch: { step?: number; firstQueryId?: string; addBuilderId?: string; completed?: boolean },
): Promise<OnboardingStatus> {
  const { db, onboardingProgress, sql, eq } = await getDb()
  await ensureOnboardingRow(userId)

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

  await db.update(onboardingProgress).set(update).where(eq(onboardingProgress.userId, userId))
  return getOnboardingStatus(userId)
}

export async function skipOnboarding(userId: string): Promise<OnboardingStatus> {
  const { db, onboardingProgress, sql, eq } = await getDb()
  await ensureOnboardingRow(userId)
  await db
    .update(onboardingProgress)
    .set({
      skipped: true,
      skippedCount: sql`${onboardingProgress.skippedCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(onboardingProgress.userId, userId))
  return getOnboardingStatus(userId)
}
