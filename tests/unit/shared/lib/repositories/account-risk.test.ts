import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { accountRisk, authUsers } from '~/shared/lib/db/schema'
import { getAccountRisk, setAccountRiskStageByAdmin, upsertAccountRisk, withPlatformUser, withWorkerUser } from '~/shared/lib/repositories/account-risk'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_account_risk')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values([
    { id: 'risk-user-a', name: 'A', email: 'risk-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'risk-user-b', name: 'B', email: 'risk-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'risk-user-admin-new', name: 'C', email: 'risk-admin-new@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'risk-user-admin-existing', name: 'D', email: 'risk-admin-existing@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('account-risk repository', () => {
  it('returns null for a user with no risk row yet (missing row)', async () => {
    const missing = await db.transaction((tx) => getAccountRisk(tx, 'risk-user-a'))
    expect(missing).toBeNull()
  })

  it('inserts then updates the same user\'s row on conflict, never duplicating it', async () => {
    await db.transaction((tx) => upsertAccountRisk(tx, { userId: 'risk-user-a', riskScore: 0, stage: 'observe' }))
    const updated = await db.transaction((tx) => upsertAccountRisk(tx, { userId: 'risk-user-a', riskScore: 40, stage: 'warned', reason: 'concurrent_sessions' }))

    expect(updated).toMatchObject({ userId: 'risk-user-a', riskScore: 40, stage: 'warned', reason: 'concurrent_sessions' })

    const rows = await db.select().from(accountRisk)
    expect(rows.filter((row) => row.userId === 'risk-user-a')).toHaveLength(1)
  })

  it('keeps risk isolated per user (A/B isolation)', async () => {
    await db.transaction((tx) => upsertAccountRisk(tx, { userId: 'risk-user-b', riskScore: 5, stage: 'observe' }))

    const a = await db.transaction((tx) => getAccountRisk(tx, 'risk-user-a'))
    const b = await db.transaction((tx) => getAccountRisk(tx, 'risk-user-b'))

    expect(a?.userId).toBe('risk-user-a')
    expect(b?.userId).toBe('risk-user-b')
    expect(a?.riskScore).not.toBe(b?.riskScore)
  })
})

describe('withWorkerUser', () => {
  it('sets app.user_id for the duration of the transaction', async () => {
    const observed = await withWorkerUser('risk-user-a', async (transaction) => {
      const [row] = await transaction.execute(sql`select current_setting('app.user_id', true) as value`) as unknown as Array<{ value: string }>
      return row.value
    }, db)

    expect(observed).toBe('risk-user-a')
  })
})

describe('withPlatformUser', () => {
  it('sets app.user_id for the duration of the transaction', async () => {
    const observed = await withPlatformUser('risk-user-b', async (transaction) => {
      const [row] = await transaction.execute(sql`select current_setting('app.user_id', true) as value`) as unknown as Array<{ value: string }>
      return row.value
    }, db)

    expect(observed).toBe('risk-user-b')
  })
})

describe('setAccountRiskStageByAdmin', () => {
  const deps = {
    withWorkerUser<T>(userId: string, fn: (tx: Parameters<Parameters<typeof withWorkerUser<T>>[1]>[0]) => Promise<T>) {
      return withWorkerUser(userId, fn, db)
    },
    withPlatformUser<T>(userId: string, fn: (tx: Parameters<Parameters<typeof withPlatformUser<T>>[1]>[0]) => Promise<T>) {
      return withPlatformUser(userId, fn, db)
    },
  }

  it('creates a baseline row then applies the admin stage when no row exists yet', async () => {
    const result = await setAccountRiskStageByAdmin('risk-user-admin-new', 'blocked', 'test block', deps)

    expect(result).toMatchObject({ userId: 'risk-user-admin-new', stage: 'blocked', reason: 'test block' })
  })

  it('overrides an existing scored row\'s stage without resetting its risk score', async () => {
    await db.transaction((tx) => upsertAccountRisk(tx, { userId: 'risk-user-admin-existing', riskScore: 77, stage: 'throttled', reason: 'auto-scored' }))

    const result = await setAccountRiskStageByAdmin('risk-user-admin-existing', 'warned', 'manual downgrade', deps)

    expect(result.stage).toBe('warned')
    expect(result.reason).toBe('manual downgrade')
    expect(result.riskScore).toBe(77)
  })
})
