// Plan 29 (activity-feed) task 6 — retention worker unit tests.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations, organizationMembers, organizationActivity } from '~/shared/lib/db/schema'
import { runActivityRetention } from '~/shared/lib/workers/activity-retention'
import { sql } from 'drizzle-orm'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const userId = 'ret-user-1'
const orgA = 'ret-org-a'
const orgB = 'ret-org-b'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('activity_retention')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: userId, name: 'U1', email: 'u1@test.invalid',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(organizations).values([
    { id: orgA, name: 'Org A', slug: orgA, createdAt: new Date() },
    { id: orgB, name: 'Org B', slug: orgB, createdAt: new Date() },
  ])
  await db.insert(organizationMembers).values([
    { id: 'ret-mem-1', userId, organizationId: orgA, role: 'owner', createdAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

async function insertRow(overrides: {
  organizationId: string
  actorUserId: string
  type: string
  targetKey: string
  metadata?: Record<string, unknown>
  occurredAt?: Date
  expiresAt?: Date | null
}) {
  const occurredAt = overrides.occurredAt ?? new Date()
  await db.execute(sql`select set_config('app.organization_id', ${overrides.organizationId}, true)`)
  await db.insert(organizationActivity).values({
    organizationId: overrides.organizationId,
    actorUserId: overrides.actorUserId,
    type: overrides.type,
    version: 1,
    targetKey: overrides.targetKey,
    metadata: overrides.metadata ?? { queryId: overrides.targetKey, queryName: 'q', visibility: 'private' },
    idempotencyKey: `${overrides.type}::${overrides.organizationId}::${overrides.actorUserId}::${overrides.targetKey}::${occurredAt.toISOString().slice(0, 10)}`,
    occurredAt,
    expiresAt: overrides.expiresAt ?? null,
  })
}

describe('runActivityRetention', () => {
  it('deletes only expired rows; forever-rows and recent rows are untouched', async () => {
    const now = new Date('2026-07-29T12:00:00Z')
    // 2 expired, 1 recent, 1 forever
    await insertRow({ organizationId: orgA, actorUserId: userId, type: 'saved_query_created', targetKey: 'q-expired-1', expiresAt: new Date('2026-01-01') })
    await insertRow({ organizationId: orgA, actorUserId: userId, type: 'saved_query_created', targetKey: 'q-expired-2', expiresAt: new Date('2026-06-01') })
    await insertRow({ organizationId: orgA, actorUserId: userId, type: 'saved_query_created', targetKey: 'q-recent', expiresAt: new Date('2027-01-01') })
    await insertRow({ organizationId: orgA, actorUserId: userId, type: 'feed_capability_minted', targetKey: 'q-forever', expiresAt: null })

    const before = await db.select({ targetKey: organizationActivity.targetKey }).from(organizationActivity)
    expect(before).toHaveLength(4)

    const result = await runActivityRetention({ db, now })
    expect(result.deleted).toBe(2)
    expect(result.scannedBatches).toBeGreaterThanOrEqual(1)
    expect(result.hitLimit).toBe(false)

    const after = await db.select({ targetKey: organizationActivity.targetKey }).from(organizationActivity)
    const targetKeys = after.map((r) => r.targetKey)
    expect(targetKeys).toContain('q-recent')
    expect(targetKeys).toContain('q-forever')
    expect(targetKeys).not.toContain('q-expired-1')
    expect(targetKeys).not.toContain('q-expired-2')
  })

  it('is idempotent: a second run after the first deletes 0', async () => {
    const now = new Date('2026-07-29T12:00:00Z')
    // From the previous test, the expired rows are gone; the
    // recent + forever rows remain. The first delete is the one
    // from the previous test, but re-running is itself a no-op.
    const result = await runActivityRetention({ db, now })
    expect(result.deleted).toBe(0)
    expect(result.scannedBatches).toBe(0)
  })

  it('is global: a row in orgB is also pruned', async () => {
    // The retention worker is a system process, not a per-org
    // one. The "expired" predicate is the only gate. An orgB
    // row past its retention is also deleted, because the only
    // requirement is that the row be product activity with a
    // past expires_at — organization_id is irrelevant to
    // retention. A separate spec test verifies that the
    // activity emit is per-org via RLS.
    const now = new Date('2026-07-29T12:00:00Z')
    await insertRow({ organizationId: orgB, actorUserId: userId, type: 'saved_query_created', targetKey: 'q-orgb', expiresAt: new Date('2026-01-01') })
    const result = await runActivityRetention({ db, now })
    expect(result.deleted).toBe(1)
    const rows = await db.select({ targetKey: organizationActivity.targetKey, organizationId: organizationActivity.organizationId })
      .from(organizationActivity)
      .where(sql`${organizationActivity.organizationId} = ${orgB}`)
    expect(rows).toHaveLength(0)
  })

  it('honors the batch size — a run with batchSize=2 deletes in pages of 2', async () => {
    // 5 expired rows; batchSize=2 means at least 3 batches.
    for (let i = 0; i < 5; i++) {
      await insertRow({ organizationId: orgA, actorUserId: userId, type: 'saved_query_created', targetKey: `q-batch-${i}`, expiresAt: new Date('2026-01-01') })
    }
    const result = await runActivityRetention({ db,
      now: new Date('2026-07-29T12:00:00Z'),
      batchSize: 2,
    })
    expect(result.deleted).toBe(5)
    expect(result.scannedBatches).toBe(3) // ceil(5/2)
    expect(result.hitLimit).toBe(false)
  })

  it('honors maxBatches — a long run that hits the cap returns hitLimit=true', async () => {
    // 5 expired rows; maxBatches=1 means we process at most 1 batch.
    for (let i = 0; i < 5; i++) {
      await insertRow({ organizationId: orgA, actorUserId: userId, type: 'saved_query_created', targetKey: `q-cap-${i}`, expiresAt: new Date('2026-01-01') })
    }
    const result = await runActivityRetention({ db,
      now: new Date('2026-07-29T12:00:00Z'),
      batchSize: 2,
      maxBatches: 1,
    })
    expect(result.deleted).toBe(2)
    expect(result.scannedBatches).toBe(1)
    expect(result.hitLimit).toBe(true)
  })
})
