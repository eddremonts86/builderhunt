import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, organizations } from '../db/schema'
import {
  assertNotRiskBlocked,
  issueRiskException,
  listRiskExceptions,
  MAX_RISK_EXCEPTION_DURATION_MS,
  PAYMENT_FAILURE_VELOCITY_THRESHOLD,
  recordPaymentFailure,
  revokeRiskException,
  RiskBlockedError,
  RiskExceptionError,
} from './risk'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `risk-${label}-${counter}`
}

async function freshOrg(): Promise<string> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  return orgId
}

const OPERATOR = { userId: 'operator-1', requestId: 'req-1' }

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('risk')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: OPERATOR.userId, name: 'Operator', email: 'operator@test.invalid',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
})

afterAll(async () => {
  await drop()
})

describe('assertNotRiskBlocked', () => {
  it('does not block an organization with no failures', async () => {
    const organizationId = await freshOrg()
    await expect(db.transaction((tx) => assertNotRiskBlocked(tx, organizationId))).resolves.toBeUndefined()
  })

  it('does not block below the velocity threshold', async () => {
    const organizationId = await freshOrg()
    const now = new Date()
    for (let i = 0; i < PAYMENT_FAILURE_VELOCITY_THRESHOLD - 1; i += 1) {
      await recordPaymentFailure(organizationId, `decline ${i}`, db)
    }
    await expect(db.transaction((tx) => assertNotRiskBlocked(tx, organizationId, now))).resolves.toBeUndefined()
  })

  it('blocks once the velocity threshold is reached', async () => {
    const organizationId = await freshOrg()
    const now = new Date()
    for (let i = 0; i < PAYMENT_FAILURE_VELOCITY_THRESHOLD; i += 1) {
      await recordPaymentFailure(organizationId, `decline ${i}`, db)
    }
    await expect(db.transaction((tx) => assertNotRiskBlocked(tx, organizationId, now))).rejects.toBeInstanceOf(RiskBlockedError)
  })

  it('does not count a failure from outside the trailing 24h window', async () => {
    const organizationId = await freshOrg()
    const now = new Date()
    const outsideWindow = new Date(now.getTime() - 25 * 60 * 60 * 1000)
    for (let i = 0; i < PAYMENT_FAILURE_VELOCITY_THRESHOLD + 2; i += 1) {
      await recordPaymentFailure(organizationId, `decline ${i}`, db)
    }
    // Directly age the events out of the window rather than re-seeding with a raw insert.
    const { billingRiskEvents } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    await db.update(billingRiskEvents).set({ createdAt: outsideWindow }).where(eq(billingRiskEvents.organizationId, organizationId))

    await expect(db.transaction((tx) => assertNotRiskBlocked(tx, organizationId, now))).resolves.toBeUndefined()
  })

  it('an active operator exception lifts the block', async () => {
    const organizationId = await freshOrg()
    const now = new Date()
    for (let i = 0; i < PAYMENT_FAILURE_VELOCITY_THRESHOLD; i += 1) {
      await recordPaymentFailure(organizationId, `decline ${i}`, db)
    }
    await issueRiskException(OPERATOR, { organizationId, reason: 'Confirmed legitimate', durationMs: 60_000 }, db)

    await expect(db.transaction((tx) => assertNotRiskBlocked(tx, organizationId, now))).resolves.toBeUndefined()
  })

  it('an expired exception no longer lifts the block', async () => {
    const organizationId = await freshOrg()
    for (let i = 0; i < PAYMENT_FAILURE_VELOCITY_THRESHOLD; i += 1) {
      await recordPaymentFailure(organizationId, `decline ${i}`, db)
    }
    const exception = await issueRiskException(OPERATOR, { organizationId, reason: 'temp', durationMs: 1000 }, db)
    const afterExpiry = new Date(exception.expiresAt.getTime() + 1)

    await expect(db.transaction((tx) => assertNotRiskBlocked(tx, organizationId, afterExpiry))).rejects.toBeInstanceOf(RiskBlockedError)
  })

  it('a revoked exception no longer lifts the block', async () => {
    const organizationId = await freshOrg()
    const now = new Date()
    for (let i = 0; i < PAYMENT_FAILURE_VELOCITY_THRESHOLD; i += 1) {
      await recordPaymentFailure(organizationId, `decline ${i}`, db)
    }
    const exception = await issueRiskException(OPERATOR, { organizationId, reason: 'temp', durationMs: 60_000 }, db)
    await revokeRiskException(organizationId, exception.id, db)

    await expect(db.transaction((tx) => assertNotRiskBlocked(tx, organizationId, now))).rejects.toBeInstanceOf(RiskBlockedError)
  })
})

describe('issueRiskException', () => {
  it('rejects a zero or negative duration', async () => {
    const organizationId = await freshOrg()
    await expect(issueRiskException(OPERATOR, { organizationId, reason: 'x', durationMs: 0 }, db)).rejects.toBeInstanceOf(RiskExceptionError)
  })

  it('rejects a duration beyond the 30-day cap', async () => {
    const organizationId = await freshOrg()
    await expect(issueRiskException(OPERATOR, { organizationId, reason: 'x', durationMs: MAX_RISK_EXCEPTION_DURATION_MS + 1 }, db))
      .rejects.toBeInstanceOf(RiskExceptionError)
  })

  it('records the issuing operator and reason', async () => {
    const organizationId = await freshOrg()
    const exception = await issueRiskException(OPERATOR, { organizationId, reason: 'Confirmed legitimate after review', durationMs: 60_000 }, db)

    expect(exception.issuedByUserId).toBe(OPERATOR.userId)
    expect(exception.reason).toBe('Confirmed legitimate after review')
    expect(exception.revokedAt).toBeNull()
  })
})

describe('listRiskExceptions / revokeRiskException', () => {
  it('lists every exception ever issued for an organization, newest first', async () => {
    const organizationId = await freshOrg()
    await issueRiskException(OPERATOR, { organizationId, reason: 'first', durationMs: 60_000 }, db)
    await issueRiskException(OPERATOR, { organizationId, reason: 'second', durationMs: 60_000 }, db)

    const exceptions = await listRiskExceptions(organizationId, db)

    expect(exceptions).toHaveLength(2)
    expect(exceptions[0].reason).toBe('second')
  })

  it('never lists another organization\'s exceptions', async () => {
    const organizationId = await freshOrg()
    const otherOrgId = await freshOrg()
    await issueRiskException(OPERATOR, { organizationId, reason: 'mine', durationMs: 60_000 }, db)

    expect(await listRiskExceptions(otherOrgId, db)).toHaveLength(0)
  })

  it('revoking an already-revoked exception is a safe no-op (returns null)', async () => {
    const organizationId = await freshOrg()
    const exception = await issueRiskException(OPERATOR, { organizationId, reason: 'x', durationMs: 60_000 }, db)

    const first = await revokeRiskException(organizationId, exception.id, db)
    const second = await revokeRiskException(organizationId, exception.id, db)

    expect(first?.revokedAt).not.toBeNull()
    expect(second).toBeNull()
  })
})
