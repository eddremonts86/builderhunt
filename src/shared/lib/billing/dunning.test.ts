import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { billingCreditGrants, organizations } from '../db/schema'
import {
  freezeIncludedGrantsForNonPayment,
  shouldBlockForNonPayment,
  unfreezeStillValidGrantsOnRecovery,
} from './dunning'

describe('shouldBlockForNonPayment', () => {
  it('is false when no grace period is in progress', () => {
    expect(shouldBlockForNonPayment({ gracePeriodEndsAt: null, paymentBlockedAt: null }, new Date('2026-06-01T00:00:00Z'))).toBe(false)
  })

  it('is false before grace has run out', () => {
    expect(shouldBlockForNonPayment(
      { gracePeriodEndsAt: new Date('2026-01-08T00:00:00Z'), paymentBlockedAt: null },
      new Date('2026-01-05T00:00:00Z'),
    )).toBe(false)
  })

  it('is true at the exact grace-end instant (inclusive) and after', () => {
    const gracePeriodEndsAt = new Date('2026-01-08T00:00:00Z')
    expect(shouldBlockForNonPayment({ gracePeriodEndsAt, paymentBlockedAt: null }, gracePeriodEndsAt)).toBe(true)
    expect(shouldBlockForNonPayment({ gracePeriodEndsAt, paymentBlockedAt: null }, new Date('2026-01-09T00:00:00Z'))).toBe(true)
  })

  it('is false once already blocked — never re-decides for an already-blocked subscription', () => {
    expect(shouldBlockForNonPayment(
      { gracePeriodEndsAt: new Date('2026-01-01T00:00:00Z'), paymentBlockedAt: new Date('2026-01-08T00:00:00Z') },
      new Date('2026-06-01T00:00:00Z'),
    )).toBe(false)
  })
})

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `dunning-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('dunning')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

async function seedOrganization(): Promise<string> {
  const organizationId = uniqueId('org')
  await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
  return organizationId
}

async function seedGrant(organizationId: string, source: string, state: 'active' | 'frozen' = 'active', expiresAt = new Date('2027-01-01T00:00:00Z')): Promise<string> {
  const id = uniqueId('grant')
  await db.insert(billingCreditGrants).values({
    id, organizationId, source, originalUnits: 100, remainingUnits: 100, state, expiresAt,
  })
  return id
}

async function readGrant(grantId: string) {
  const [row] = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.id, grantId))
  return row
}

describe('freezeIncludedGrantsForNonPayment', () => {
  it('freezes subscription-sourced grants but leaves pack grants untouched', async () => {
    const organizationId = await seedOrganization()
    const monthlyGrant = await seedGrant(organizationId, 'subscription_monthly')
    const annualWindowGrant = await seedGrant(organizationId, 'subscription_annual_window')
    const upgradeGrant = await seedGrant(organizationId, 'subscription_upgrade_delta')
    const packGrant = await seedGrant(organizationId, 'pack')

    const frozen = await db.transaction((tx) => freezeIncludedGrantsForNonPayment(tx, organizationId, `sub_${organizationId}`))

    expect(frozen).toBe(3)
    expect((await readGrant(monthlyGrant)).state).toBe('frozen')
    expect((await readGrant(annualWindowGrant)).state).toBe('frozen')
    expect((await readGrant(upgradeGrant)).state).toBe('frozen')
    expect((await readGrant(packGrant)).state).toBe('active') // preserved, never frozen
  })

  it('is idempotent — a second call freezes nothing new and never errors', async () => {
    const organizationId = await seedOrganization()
    await seedGrant(organizationId, 'subscription_monthly')

    const first = await db.transaction((tx) => freezeIncludedGrantsForNonPayment(tx, organizationId, `sub_${organizationId}`))
    const second = await db.transaction((tx) => freezeIncludedGrantsForNonPayment(tx, organizationId, `sub_${organizationId}`))

    expect(first).toBe(1)
    expect(second).toBe(0) // already frozen, nothing left to freeze
  })

  it('does nothing for an organization with no active grants', async () => {
    const organizationId = await seedOrganization()
    const frozen = await db.transaction((tx) => freezeIncludedGrantsForNonPayment(tx, organizationId, `sub_${organizationId}`))
    expect(frozen).toBe(0)
  })
})

describe('unfreezeStillValidGrantsOnRecovery', () => {
  it('unfreezes a frozen grant that has not yet expired', async () => {
    const organizationId = await seedOrganization()
    const grantId = await seedGrant(organizationId, 'subscription_monthly', 'frozen', new Date('2027-01-01T00:00:00Z'))

    const result = await db.transaction((tx) => unfreezeStillValidGrantsOnRecovery(tx, organizationId, `sub_${organizationId}`, new Date('2026-06-01T00:00:00Z')))

    expect(result).toEqual({ unfrozen: 1, expired: 0 })
    expect((await readGrant(grantId)).state).toBe('active')
  })

  it('expires (rather than unfreezes) a grant whose expiry passed while it was frozen', async () => {
    const organizationId = await seedOrganization()
    const grantId = await seedGrant(organizationId, 'subscription_monthly', 'frozen', new Date('2026-01-01T00:00:00Z'))

    const result = await db.transaction((tx) => unfreezeStillValidGrantsOnRecovery(tx, organizationId, `sub_${organizationId}`, new Date('2026-06-01T00:00:00Z')))

    expect(result).toEqual({ unfrozen: 0, expired: 1 })
    const row = await readGrant(grantId)
    expect(row.state).toBe('expired')
    expect(row.remainingUnits).toBe(0)
  })

  it('handles a mix of still-valid and expired-while-frozen grants in one pass', async () => {
    const organizationId = await seedOrganization()
    const validGrant = await seedGrant(organizationId, 'subscription_monthly', 'frozen', new Date('2027-01-01T00:00:00Z'))
    const expiredGrant = await seedGrant(organizationId, 'subscription_annual_window', 'frozen', new Date('2026-01-01T00:00:00Z'))

    const result = await db.transaction((tx) => unfreezeStillValidGrantsOnRecovery(tx, organizationId, `sub_${organizationId}`, new Date('2026-06-01T00:00:00Z')))

    expect(result).toEqual({ unfrozen: 1, expired: 1 })
    expect((await readGrant(validGrant)).state).toBe('active')
    expect((await readGrant(expiredGrant)).state).toBe('expired')
  })

  it('never touches an active (never-frozen) grant', async () => {
    const organizationId = await seedOrganization()
    const activeGrant = await seedGrant(organizationId, 'pack', 'active')

    const result = await db.transaction((tx) => unfreezeStillValidGrantsOnRecovery(tx, organizationId, `sub_${organizationId}`, new Date('2026-06-01T00:00:00Z')))

    expect(result).toEqual({ unfrozen: 0, expired: 0 })
    expect((await readGrant(activeGrant)).state).toBe('active')
  })

  it('is idempotent — a second recovery call finds nothing left frozen', async () => {
    const organizationId = await seedOrganization()
    await seedGrant(organizationId, 'subscription_monthly', 'frozen')
    const now = new Date('2026-06-01T00:00:00Z')

    const first = await db.transaction((tx) => unfreezeStillValidGrantsOnRecovery(tx, organizationId, `sub_${organizationId}`, now))
    const second = await db.transaction((tx) => unfreezeStillValidGrantsOnRecovery(tx, organizationId, `sub_${organizationId}`, now))

    expect(first.unfrozen).toBe(1)
    expect(second).toEqual({ unfrozen: 0, expired: 0 })
  })
})
