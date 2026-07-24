import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, organizations } from '../db/schema'
import { getSeatUsage, incrementSeatUsage } from './seat-usage'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_seat_usage')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: 'seat-org-a', name: 'A', slug: 'seat-org-a', createdAt: new Date() },
    { id: 'seat-org-b', name: 'B', slug: 'seat-org-b', createdAt: new Date() },
  ])
  await db.insert(authUsers).values([
    { id: 'seat-user-a', name: 'A', email: 'seat-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'seat-user-b', name: 'B', email: 'seat-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('seat-usage repository', () => {
  it('returns null for a (org, user, day, action) with no usage yet (missing row)', async () => {
    const missing = await db.transaction((tx) => getSeatUsage(tx, 'seat-org-a', 'seat-user-a', '2026-01-01', 'searches'))
    expect(missing).toBeNull()
  })

  it('increments the same counter across repeated calls instead of overwriting it', async () => {
    const id = randomUUID()
    await db.transaction((tx) => incrementSeatUsage(tx, { id, organizationId: 'seat-org-a', userId: 'seat-user-a', day: '2026-01-02', action: 'searches' }))
    await db.transaction((tx) => incrementSeatUsage(tx, { id: randomUUID(), organizationId: 'seat-org-a', userId: 'seat-user-a', day: '2026-01-02', action: 'searches', count: 4 }))

    const usage = await db.transaction((tx) => getSeatUsage(tx, 'seat-org-a', 'seat-user-a', '2026-01-02', 'searches'))
    expect(usage?.count).toBe(5)
  })

  it('tracks distinct actions for the same (org, user, day) independently', async () => {
    await db.transaction((tx) => incrementSeatUsage(tx, { id: randomUUID(), organizationId: 'seat-org-a', userId: 'seat-user-a', day: '2026-01-03', action: 'searches' }))
    await db.transaction((tx) => incrementSeatUsage(tx, { id: randomUUID(), organizationId: 'seat-org-a', userId: 'seat-user-a', day: '2026-01-03', action: 'exports', count: 2 }))

    const searches = await db.transaction((tx) => getSeatUsage(tx, 'seat-org-a', 'seat-user-a', '2026-01-03', 'searches'))
    const exports = await db.transaction((tx) => getSeatUsage(tx, 'seat-org-a', 'seat-user-a', '2026-01-03', 'exports'))
    expect(searches?.count).toBe(1)
    expect(exports?.count).toBe(2)
  })

  it('keeps usage isolated per organization (A/B isolation)', async () => {
    await db.transaction((tx) => incrementSeatUsage(tx, { id: randomUUID(), organizationId: 'seat-org-a', userId: 'seat-user-a', day: '2026-01-04', action: 'reveals', count: 3 }))
    await db.transaction((tx) => incrementSeatUsage(tx, { id: randomUUID(), organizationId: 'seat-org-b', userId: 'seat-user-b', day: '2026-01-04', action: 'reveals', count: 7 }))

    const usageA = await db.transaction((tx) => getSeatUsage(tx, 'seat-org-a', 'seat-user-a', '2026-01-04', 'reveals'))
    const usageB = await db.transaction((tx) => getSeatUsage(tx, 'seat-org-b', 'seat-user-b', '2026-01-04', 'reveals'))
    expect(usageA?.count).toBe(3)
    expect(usageB?.count).toBe(7)
  })

  it('accumulates creditUnits alongside count', async () => {
    await db.transaction((tx) => incrementSeatUsage(tx, { id: randomUUID(), organizationId: 'seat-org-a', userId: 'seat-user-a', day: '2026-01-05', action: 'messages', count: 1, creditUnits: 2 }))
    await db.transaction((tx) => incrementSeatUsage(tx, { id: randomUUID(), organizationId: 'seat-org-a', userId: 'seat-user-a', day: '2026-01-05', action: 'messages', count: 1, creditUnits: 3 }))

    const usage = await db.transaction((tx) => getSeatUsage(tx, 'seat-org-a', 'seat-user-a', '2026-01-05', 'messages'))
    expect(usage).toMatchObject({ count: 2, creditUnits: 5 })
  })
})
