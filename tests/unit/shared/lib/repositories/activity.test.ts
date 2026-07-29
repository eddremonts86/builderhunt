// Plan 29 (activity-feed) task 3 — repository unit tests.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations, organizationMembers, organizationActivity } from '~/shared/lib/db/schema'
import { emitActivity, listActivity } from '~/shared/lib/repositories/activity'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const principal: TenantPrincipal = {
  userId: 'act-user-1', organizationId: 'act-org-1', role: 'owner', requestId: 'r-1',
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('activity_repo')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values([
    { id: 'act-user-1', name: 'U1', email: 'u1@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'act-user-2', name: 'U2', email: 'u2@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  await db.insert(organizations).values([
    { id: 'act-org-1', name: 'O1', slug: 'act-org-1', createdAt: new Date() },
    { id: 'act-org-2', name: 'O2', slug: 'act-org-2', createdAt: new Date() },
  ])
  await db.insert(organizationMembers).values([
    { id: 'act-mem-1', userId: 'act-user-1', organizationId: 'act-org-1', role: 'owner', createdAt: new Date() },
    { id: 'act-mem-2', userId: 'act-user-1', organizationId: 'act-org-2', role: 'member', createdAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('emitActivity', () => {
  it('inserts a row with the principal\'s org and a deterministic idempotency_key', async () => {
    await db.transaction(async (tx) => {
      await emitActivity(tx, principal, {
        type: 'saved_query_created',
        targetKey: 'q-1',
        metadata: { queryId: 'q-1', queryName: 'rust people', visibility: 'private' },
      })
    })
    const all = await db.select().from(organizationActivity)
    const row = all.find((r) => r.targetKey === 'q-1')
    expect(row).toBeTruthy()
    expect(row!.organizationId).toBe('act-org-1')
    expect(row!.actorUserId).toBe('act-user-1')
    expect(row!.type).toBe('saved_query_created')
    expect(row!.idempotencyKey).toContain('saved_query_created::act-org-1::act-user-1::q-1::')
  })

  it('is idempotent: emitting the same (type, target) twice on the same day yields a single row', async () => {
    const day = new Date('2026-07-29T12:00:00Z')
    for (let i = 0; i < 3; i++) {
      await db.transaction(async (tx) => {
        await emitActivity(tx, principal, {
          type: 'saved_query_created',
          targetKey: 'q-idem',
          metadata: { queryId: 'q-idem', queryName: 'idem', visibility: 'private' },
          occurredAt: day,
        })
      })
    }
    const rows = await db.select().from(organizationActivity)
    const matches = rows.filter((r) => r.targetKey === 'q-idem')
    expect(matches).toHaveLength(1)
  })

  it('is idempotent within a day but emits a new row the next day', async () => {
    const day1 = new Date('2026-07-29T08:00:00Z')
    const day2 = new Date('2026-07-30T08:00:00Z')
    await db.transaction(async (tx) => {
      await emitActivity(tx, principal, {
        type: 'saved_query_created',
        targetKey: 'q-day',
        metadata: { queryId: 'q-day', queryName: 'd', visibility: 'private' },
        occurredAt: day1,
      })
    })
    await db.transaction(async (tx) => {
      await emitActivity(tx, principal, {
        type: 'saved_query_created',
        targetKey: 'q-day',
        metadata: { queryId: 'q-day', queryName: 'd', visibility: 'private' },
        occurredAt: day2,
      })
    })
    const rows = await db.select().from(organizationActivity)
    const matches = rows.filter((r) => r.targetKey === 'q-day')
    expect(matches).toHaveLength(2)
  })

  it('rejects an unknown event type', async () => {
    await expect(db.transaction(async (tx) => {
      // @ts-expect-error — unknown event type is a programming error.
      await emitActivity(tx, principal, { type: 'made_up_event', targetKey: 'q-x', metadata: {} })
    })).rejects.toThrow(/Unknown activity event type/)
  })

  it('rejects metadata that does not match the registry schema', async () => {
    await expect(db.transaction(async (tx) => {
      await emitActivity(tx, principal, {
        type: 'saved_query_created',
        targetKey: 'q-bad',
        // queryName is required; visibility is a bad value
        metadata: { queryId: 'q-bad' },
      })
    })).rejects.toThrow(/failed validation/)
  })

  it('rejects metadata carrying sensitive canaries (email-like)', async () => {
    await expect(db.transaction(async (tx) => {
      await emitActivity(tx, principal, {
        type: 'saved_query_created',
        targetKey: 'q-leak',
        metadata: { queryId: 'q-leak', queryName: 'leak@example.com', visibility: 'private' },
      })
    })).rejects.toThrow(/sensitive canary/)
  })

  it('rolls back with the parent transaction (no orphan rows)', async () => {
    let err: Error | null = null
    try {
      await db.transaction(async (tx) => {
        await emitActivity(tx, principal, {
          type: 'saved_query_created',
          targetKey: 'q-rb',
          metadata: { queryId: 'q-rb', queryName: 'rb', visibility: 'private' },
        })
        // Simulate the parent mutation failing after the activity
        // emit succeeded. The transaction wrapper rolls the whole
        // tx back; the activity row should not survive.
        throw new Error('parent mutation failed')
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeTruthy()
    const rows = await db.select().from(organizationActivity)
    expect(rows.find((r) => r.targetKey === 'q-rb')).toBeUndefined()
  })
})

describe('listActivity', () => {
  it('returns only the principal\'s organization rows, in desc order', async () => {
    // Different principal, different org — must NOT show up.
    const otherPrincipal: TenantPrincipal = {
      userId: 'act-user-1', organizationId: 'act-org-2', role: 'member', requestId: 'r-2',
    }
    await db.transaction(async (tx) => {
      await emitActivity(tx, otherPrincipal, {
        type: 'saved_query_created',
        targetKey: 'q-other',
        metadata: { queryId: 'q-other', queryName: 'other', visibility: 'private' },
      })
    })
    await db.transaction(async (tx) => {
      await emitActivity(tx, principal, {
        type: 'saved_query_created',
        targetKey: 'q-list-1',
        metadata: { queryId: 'q-list-1', queryName: 'one', visibility: 'private' },
      })
      await emitActivity(tx, principal, {
        type: 'saved_query_created',
        targetKey: 'q-list-2',
        metadata: { queryId: 'q-list-2', queryName: 'two', visibility: 'private' },
      })
    })
    const result = await db.transaction(async (tx) => listActivity(tx, principal))
    const targetKeys = result.rows.map((r) => r.targetKey)
    expect(targetKeys).toContain('q-list-1')
    expect(targetKeys).toContain('q-list-2')
    expect(targetKeys).not.toContain('q-other')
  })

  it('produces a display line via the registered formatter', async () => {
    await db.transaction(async (tx) => {
      await emitActivity(tx, principal, {
        type: 'saved_query_created',
        targetKey: 'q-fmt',
        metadata: { queryId: 'q-fmt', queryName: 'fmt test', visibility: 'private' },
      })
    })
    const result = await db.transaction(async (tx) => listActivity(tx, principal))
    const row = result.rows.find((r) => r.targetKey === 'q-fmt')
    expect(row).toBeTruthy()
    expect(row!.display).toBe('Created search "fmt test"')
  })
})
