import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { alerts, authUsers, organizations } from '~/shared/lib/db/schema'
import { markWorkerAlertEvaluated } from '~/shared/lib/repositories/alerts-worker'

/**
 * Persisted alert-timing behaviour against a real database (plan:
 * calendar-scheduling-interview-intelligence, Phase 4).
 *
 * The pure cadence maths lives in `alerts.test.ts`. What this file adds is the part only a database
 * can answer: that the four timing fields land in one statement, that the check constraint holds,
 * and that the worker's column-scoped grant is still narrow.
 */

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'alt-org'
const USER = 'alt-user'
const ALERT = 'alt-alert'
const AT = new Date('2027-06-01T12:00:00.000Z')

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('alerts_timing')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Alt', slug: 'alt-org' })
  await db.insert(authUsers).values({
    id: USER, name: 'User', email: 'alt-user@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 60_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  await db.delete(alerts)
  await db.insert(alerts).values({
    id: ALERT,
    organizationId: ORG,
    userId: USER,
    name: 'Weekly watch',
    keywords: ['rust'],
    frequency: 'weekly',
    enabled: true,
  })
})

async function alertRow() {
  const [row] = await db.select().from(alerts).where(eq(alerts.id, ALERT))
  return row
}

describe('markWorkerAlertEvaluated', () => {
  it('writes all four timing fields in one statement on success', async () => {
    const result = await db.transaction((tx) => markWorkerAlertEvaluated(
      tx, ORG, { id: ALERT, frequency: 'weekly', consecutiveFailures: 3 }, { succeeded: true }, AT,
    ))

    expect(result).not.toBeNull()
    const row = await alertRow()
    expect(row.lastCheckedAt).toEqual(AT)
    expect(row.consecutiveFailures).toBe(0)
    expect(row.lastEvaluationErrorCode).toBeNull()
    // One weekly window (6.5 days) out.
    expect(row.nextEvaluationAt!.getTime() - AT.getTime()).toBe(6.5 * 24 * 60 * 60 * 1000)
  })

  it('schedules a failed weekly alert minutes out, not a week', async () => {
    await db.transaction((tx) => markWorkerAlertEvaluated(
      tx, ORG, { id: ALERT, frequency: 'weekly', consecutiveFailures: 0 },
      { succeeded: false, errorCode: 'rate_limited' }, AT,
    ))

    const row = await alertRow()
    expect(row.consecutiveFailures).toBe(1)
    expect(row.lastEvaluationErrorCode).toBe('rate_limited')
    // The whole point of the backoff: one transient error must not silence a weekly alert for 7 days.
    expect(row.nextEvaluationAt!.getTime() - AT.getTime()).toBe(5 * 60 * 1000)
  })

  it('never stores a provider message in the user-visible error column', async () => {
    await db.transaction((tx) => markWorkerAlertEvaluated(
      tx, ORG, { id: ALERT, frequency: 'daily', consecutiveFailures: 0 },
      { succeeded: false, errorCode: 'https://api.github.com refused: ghp_secret' }, AT,
    ))

    const row = await alertRow()
    expect(row.lastEvaluationErrorCode).toBe('evaluation_failed')
    expect(JSON.stringify(row)).not.toContain('ghp_secret')
  })

  it('cannot reach an alert in another organization', async () => {
    const result = await db.transaction((tx) => markWorkerAlertEvaluated(
      tx, 'some-other-org', { id: ALERT, frequency: 'weekly', consecutiveFailures: 0 }, { succeeded: true }, AT,
    ))

    expect(result).toBeNull()
    expect((await alertRow()).lastCheckedAt).toBeNull()
  })

  it('leaves everything else about the alert untouched', async () => {
    await db.transaction((tx) => markWorkerAlertEvaluated(
      tx, ORG, { id: ALERT, frequency: 'weekly', consecutiveFailures: 0 }, { succeeded: true }, AT,
    ))

    const row = await alertRow()
    // The worker writes timing, never configuration. The column-scoped GRANT in 0073 enforces this
    // against the real role; this assertion catches an accidental widening of the `set` object,
    // which the disposable (owner-role) database would otherwise allow silently.
    expect(row).toMatchObject({ enabled: true, frequency: 'weekly', name: 'Weekly watch' })
    expect(row.keywords).toEqual(['rust'])
  })

  it('rejects a negative failure count at the database level', async () => {
    await expect(
      db.update(alerts).set({ consecutiveFailures: -1 }).where(eq(alerts.id, ALERT)),
    ).rejects.toThrow()
  })
})

describe('the worker grant stays column-scoped', () => {
  it('grants UPDATE only on timing columns, never on configuration', async () => {
    // A `GRANT UPDATE ON TABLE alerts` would be the easy fix for a permission error and the wrong
    // one: it would let a compromised worker disable every alert or rewrite what they match on.
    const migration = await readFile('drizzle/0073_alert_evaluation_timing_grant.sql', 'utf8')
    // Executable lines only — the file's own comment names the forbidden table-wide form in order
    // to explain why it was not used, and matching that would make this assertion vacuous.
    const statements = migration
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith('--'))
      .join('\n')

    for (const column of ['next_evaluation_at', 'consecutive_failures', 'last_evaluation_error_code']) {
      expect(statements).toContain(`GRANT UPDATE (${column}) ON TABLE alerts TO builderhunt_worker;`)
    }
    expect(statements).not.toMatch(/GRANT UPDATE ON TABLE alerts/)
    expect(statements).not.toMatch(/GRANT UPDATE \((enabled|keywords|trigger_conditions|frequency|user_id)\)/)
  })
})
