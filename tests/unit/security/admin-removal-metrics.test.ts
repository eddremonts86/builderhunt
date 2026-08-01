/**
 * plans/UI/tasks.md Wave 5 "Render redacted removal operations metrics".
 *
 * `getRemovalOperationsMetrics` against a real database — proves the empty, small-cohort-suppressed,
 * healthy, and overdue fixtures the task's own verify line names, and that the returned DTO never
 * carries identity, a URL, request text, evidence, or any other per-request field.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { profileRemovalRequests, profileSuppressions } from '~/shared/lib/db/schema'
import { getRemovalOperationsMetrics } from '~/shared/lib/repositories/profile-removal'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('admin_removal_metrics')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(profileSuppressions)
  await db.delete(profileRemovalRequests)
})

let seq = 0
async function insertRequest(overrides: {
  status?: 'pending' | 'verified' | 'rejected' | 'expired'
  source?: string
  createdAt?: Date
  expiresAt?: Date
} = {}) {
  seq += 1
  await db.insert(profileRemovalRequests).values({
    id: `req-${seq}`,
    source: overrides.source ?? 'github',
    sourceId: `sid-${seq}`,
    normalizedProfileUrl: `https://github.com/user-${seq}`,
    requesterEmailHash: `hash-${seq}`,
    challengeHash: `challenge-${seq}`,
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
  })
}

async function insertSuppression(overrides: { revokedAt?: Date | null } = {}) {
  seq += 1
  await db.insert(profileSuppressions).values({
    id: `sup-${seq}`,
    source: 'github',
    sourceId: `sid-${seq}`,
    normalizedProfileUrlHash: `hash-${seq}`,
    reason: 'verified-removal',
    revokedAt: overrides.revokedAt ?? null,
  })
}

describe('getRemovalOperationsMetrics', () => {
  it('reports an entirely empty pipeline honestly', async () => {
    const metrics = await getRemovalOperationsMetrics(new Date(), db as never)
    expect(metrics.totalRequests).toBe(0)
    expect(metrics.byStatus).toEqual({ pending: 0, verified: 0, rejected: 0, expired: 0 })
    expect(metrics.bySource).toEqual([])
    expect(metrics.otherSourcesCount).toBe(0)
    expect(metrics.overduePendingCount).toBe(0)
    expect(metrics.activeSuppressions).toBe(0)
  })

  it('folds a source with fewer than the disclosure threshold into otherSourcesCount', async () => {
    // 3 requests from "gitlab" — below MIN_COHORT_FOR_SOURCE_DISCLOSURE (5) — must not be named.
    await insertRequest({ source: 'gitlab' })
    await insertRequest({ source: 'gitlab' })
    await insertRequest({ source: 'gitlab' })

    const metrics = await getRemovalOperationsMetrics(new Date(), db as never)
    expect(metrics.bySource).toEqual([])
    expect(metrics.otherSourcesCount).toBe(3)
    expect(JSON.stringify(metrics)).not.toContain('gitlab')
  })

  it('names a source once its own count meets the disclosure threshold', async () => {
    for (let i = 0; i < 5; i += 1) await insertRequest({ source: 'github' })
    await insertRequest({ source: 'gitlab' }) // below threshold, folded

    const metrics = await getRemovalOperationsMetrics(new Date(), db as never)
    expect(metrics.bySource).toEqual([{ source: 'github', count: 5 }])
    expect(metrics.otherSourcesCount).toBe(1)
  })

  it('buckets pending requests by age and reports byStatus counts for a healthy mix', async () => {
    const now = new Date()
    await insertRequest({ status: 'pending', createdAt: new Date(now.getTime() - 60_000) }) // under 1 day
    await insertRequest({ status: 'pending', createdAt: new Date(now.getTime() - 3 * 86_400_000) }) // 1-7 days
    await insertRequest({ status: 'pending', createdAt: new Date(now.getTime() - 10 * 86_400_000) }) // 7-30 days
    await insertRequest({ status: 'pending', createdAt: new Date(now.getTime() - 40 * 86_400_000) }) // >30 days
    await insertRequest({ status: 'verified' })
    await insertRequest({ status: 'rejected' })
    await insertRequest({ status: 'expired' })

    const metrics = await getRemovalOperationsMetrics(now, db as never)
    expect(metrics.totalRequests).toBe(7)
    expect(metrics.byStatus).toEqual({ pending: 4, verified: 1, rejected: 1, expired: 1 })
    expect(metrics.pendingAging).toEqual({ underOneDay: 1, oneToSevenDays: 1, sevenToThirtyDays: 1, overThirtyDays: 1 })
    expect(metrics.overduePendingCount).toBe(0)
  })

  it('flags a pending request already past its own expiresAt as overdue', async () => {
    const now = new Date()
    await insertRequest({ status: 'pending', createdAt: new Date(now.getTime() - 2 * 86_400_000), expiresAt: new Date(now.getTime() - 86_400_000) })
    await insertRequest({ status: 'pending', createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) })

    const metrics = await getRemovalOperationsMetrics(now, db as never)
    expect(metrics.overduePendingCount).toBe(1)
  })

  it('counts only active (unrevoked) suppressions', async () => {
    await insertSuppression()
    await insertSuppression()
    await insertSuppression({ revokedAt: new Date() })

    const metrics = await getRemovalOperationsMetrics(new Date(), db as never)
    expect(metrics.activeSuppressions).toBe(2)
  })

  it('never returns identity, a URL, request text, evidence, or other per-request metadata', async () => {
    await insertRequest({ source: 'github' })
    await insertSuppression()

    const metrics = await getRemovalOperationsMetrics(new Date(), db as never)
    const allowedKeys = new Set([
      'totalRequests', 'byStatus', 'bySource', 'otherSourcesCount', 'pendingAging',
      'overduePendingCount', 'activeSuppressions', 'generatedAt',
    ])
    expect(Object.keys(metrics).sort()).toEqual([...allowedKeys].sort())

    const serialized = JSON.stringify(metrics)
    expect(serialized).not.toContain('sid-')
    expect(serialized).not.toContain('hash-')
    expect(serialized).not.toContain('challenge-')
    expect(serialized).not.toContain('github.com')
    expect(serialized).not.toContain('req-')
    expect(serialized).not.toContain('sup-')
  })
})
