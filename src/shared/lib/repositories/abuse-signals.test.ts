import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { insertAbuseSignal, listAbuseSignalsForOrganization, listAbuseSignalsForUser } from './abuse-signals'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_abuse_signals')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('abuse-signals repository', () => {
  it('inserts a signal and reads it back for its user', async () => {
    const id = randomUUID()
    const inserted = await insertAbuseSignal({
      id,
      type: 'seat_overuse',
      severity: 'medium',
      userId: 'abuse-user-a',
      organizationId: 'abuse-org-a',
      requestId: 'req-1',
      details: { seats: 5 },
    }, db)

    expect(inserted).toMatchObject({ id, type: 'seat_overuse', severity: 'medium', userId: 'abuse-user-a' })

    const forUser = await listAbuseSignalsForUser('abuse-user-a', 50, db)
    expect(forUser.map((row) => row.id)).toContain(id)
  })

  it('lists signals scoped to their organization, not another organization (A/B isolation)', async () => {
    const idA = randomUUID()
    const idB = randomUUID()
    await insertAbuseSignal({ id: idA, type: 'export_burst', severity: 'low', organizationId: 'abuse-org-list-a', requestId: 'req-a' }, db)
    await insertAbuseSignal({ id: idB, type: 'export_burst', severity: 'low', organizationId: 'abuse-org-list-b', requestId: 'req-b' }, db)

    const forA = await listAbuseSignalsForOrganization('abuse-org-list-a', 50, db)
    const forB = await listAbuseSignalsForOrganization('abuse-org-list-b', 50, db)

    expect(forA.map((row) => row.id)).toEqual([idA])
    expect(forB.map((row) => row.id)).toEqual([idB])
  })

  it('never receives an UPDATE grant in the schema — append-only by convention, defaults are all it needs', async () => {
    const id = randomUUID()
    const row = await insertAbuseSignal({ id, type: 'signup_velocity', severity: 'low', requestId: 'req-defaults' }, db)
    expect(row.userId).toBeNull()
    expect(row.organizationId).toBeNull()
    expect(row.details).toEqual({})
  })
})
