import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers } from '../db/schema'
import { findUserDevice, upsertUserDevice } from './user-devices'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_user_devices')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values([
    { id: 'device-user-a', name: 'A', email: 'device-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'device-user-b', name: 'B', email: 'device-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('user-devices repository', () => {
  it('reports a brand-new device as new and persists it', async () => {
    const id = randomUUID()
    const { device, isNewDevice } = await db.transaction((tx) => upsertUserDevice(tx, {
      id,
      userId: 'device-user-a',
      deviceHash: 'hash-first-a',
      uaFamily: 'chrome',
    }))

    expect(isNewDevice).toBe(true)
    expect(device).toMatchObject({ id, userId: 'device-user-a', deviceHash: 'hash-first-a', trustState: 'new' })
  })

  it('reports a re-seen device as not new, and updates lastSeenAt/uaFamily', async () => {
    const id = randomUUID()
    await db.transaction((tx) => upsertUserDevice(tx, { id, userId: 'device-user-a', deviceHash: 'hash-repeat-a', uaFamily: 'chrome' }))

    const second = await db.transaction((tx) => upsertUserDevice(tx, {
      id: randomUUID(),
      userId: 'device-user-a',
      deviceHash: 'hash-repeat-a',
      uaFamily: 'firefox',
    }))

    expect(second.isNewDevice).toBe(false)
    expect(second.device.id).toBe(id)
    expect(second.device.uaFamily).toBe('firefox')
  })

  it('keeps devices isolated per user — same device hash for two different users creates two rows (A/B isolation)', async () => {
    await db.transaction((tx) => upsertUserDevice(tx, { id: randomUUID(), userId: 'device-user-a', deviceHash: 'hash-shared', uaFamily: 'chrome' }))
    await db.transaction((tx) => upsertUserDevice(tx, { id: randomUUID(), userId: 'device-user-b', deviceHash: 'hash-shared', uaFamily: 'chrome' }))

    const forA = await db.transaction((tx) => findUserDevice(tx, 'device-user-a', 'hash-shared'))
    const forB = await db.transaction((tx) => findUserDevice(tx, 'device-user-b', 'hash-shared'))

    expect(forA?.userId).toBe('device-user-a')
    expect(forB?.userId).toBe('device-user-b')
    expect(forA?.id).not.toBe(forB?.id)
  })

  it('returns null for a device that was never seen (missing row)', async () => {
    const missing = await db.transaction((tx) => findUserDevice(tx, 'device-user-a', 'hash-never-seen'))
    expect(missing).toBeNull()
  })
})
