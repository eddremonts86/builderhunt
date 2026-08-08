import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, billingCreditGrants, billingCustomers, billingDisputes, billingRefunds, billingSubscriptions, organizationMembers, organizations } from '~/shared/lib/db/schema'
import { getAccountingExport } from '~/shared/lib/billing/accounting-export'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `acct-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('accounting_export')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

async function freshOrg(): Promise<string> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizationMembers).values({ id: uniqueId('member'), organizationId: orgId, userId, role: 'owner', createdAt: new Date() })
  return orgId
}

async function seedCustomer(organizationId: string): Promise<string> {
  const customerId = uniqueId('cust-row')
  await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
  return customerId
}

function deps(overrides: Partial<Parameters<typeof getAccountingExport>[0]> = {}) {
  return { worker: db, ...overrides }
}

// Deliberately runs FIRST (vitest executes tests within a file in declaration order) — unexpired
// credit liability is a point-in-time, cross-organization total with no window filter, so it is the
// one metric every later test's grant-seeding would otherwise contaminate. Every other describe block
// below uses its own far-future, non-overlapping month window so window-filtered metrics stay exact
// regardless of test order.
describe('getAccountingExport — unexpired credit liability', () => {
  it('sums remainingUnits across active, unexpired grants and excludes an already-expired one', async () => {
    const orgId = await freshOrg()
    await db.insert(billingCreditGrants).values({
      id: uniqueId('grant'), organizationId: orgId, source: 'pack',
      originalUnits: 300, remainingUnits: 300, state: 'active', expiresAt: new Date('2099-01-01T00:00:00Z'),
    })
    await db.insert(billingCreditGrants).values({
      id: uniqueId('grant'), organizationId: orgId, source: 'pack',
      originalUnits: 1000, remainingUnits: 1000, state: 'active', expiresAt: new Date('2020-01-01T00:00:00Z'),
    })

    const result = await getAccountingExport(deps())

    expect(result.unexpiredCreditLiability.units).toBe(300)
  })
})

describe('getAccountingExport — gross revenue estimate', () => {
  it('counts a subscription whose currentPeriodStart falls inside the window, resolved to its catalog price', async () => {
    const orgId = await freshOrg()
    const customerId = await seedCustomer(orgId)
    await db.insert(billingSubscriptions).values({
      id: uniqueId('sub-row'), organizationId: orgId, customerId, livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus: 'active',
      currentPeriodStart: new Date('2031-03-15T00:00:00Z'),
    })

    const result = await getAccountingExport(deps({ windowStart: new Date('2031-03-01T00:00:00Z'), windowEnd: new Date('2031-04-01T00:00:00Z') }))

    expect(result.grossRevenue.subscriptionCents).toBe(1900) // pro_monthly's catalog amountCents
    expect(result.grossRevenue.subscriptionCount).toBe(1)
    expect(result.grossRevenue.basis).toBe('catalog_price_estimate')
  })

  it('excludes a subscription whose currentPeriodStart falls outside the window', async () => {
    const orgId = await freshOrg()
    const customerId = await seedCustomer(orgId)
    await db.insert(billingSubscriptions).values({
      id: uniqueId('sub-row'), organizationId: orgId, customerId, livemode: false,
      catalogKey: 'team_monthly', tier: 'team', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus: 'active',
      currentPeriodStart: new Date('2031-05-15T00:00:00Z'),
    })

    const result = await getAccountingExport(deps({ windowStart: new Date('2031-04-01T00:00:00Z'), windowEnd: new Date('2031-05-01T00:00:00Z') }))

    expect(result.grossRevenue.subscriptionCount).toBe(0)
  })

  it('counts a pack purchase grant whose createdAt falls inside the window, resolved to its catalog price', async () => {
    const orgId = await freshOrg()
    await db.insert(billingCreditGrants).values({
      id: uniqueId('grant'), organizationId: orgId, source: 'pack', sourceReference: 'starter_300',
      originalUnits: 300, remainingUnits: 300, expiresAt: new Date('2099-01-01T00:00:00Z'),
      createdAt: new Date('2031-06-15T00:00:00Z'),
    })

    const result = await getAccountingExport(deps({ windowStart: new Date('2031-06-01T00:00:00Z'), windowEnd: new Date('2031-07-01T00:00:00Z') }))

    expect(result.grossRevenue.packCents).toBe(1500) // starter_300's catalog amountCents
    expect(result.grossRevenue.packCount).toBe(1)
  })
})

describe('getAccountingExport — refunds', () => {
  it('sums only succeeded refunds inside the window, excluding pending and out-of-window rows', async () => {
    const orgId = await freshOrg()
    const requesterId = await freshUserId()
    await db.insert(billingRefunds).values({
      id: uniqueId('refund'), organizationId: orgId, requestedByUserId: requesterId,
      idempotencyKey: uniqueId('idem'), policyDecision: 'full_unused_pack', amountCents: 500, state: 'succeeded',
      createdAt: new Date('2031-08-15T00:00:00Z'),
    })
    await db.insert(billingRefunds).values({
      id: uniqueId('refund'), organizationId: orgId, requestedByUserId: requesterId,
      idempotencyKey: uniqueId('idem'), policyDecision: 'full_unused_pack', amountCents: 999, state: 'pending',
      createdAt: new Date('2031-08-16T00:00:00Z'),
    })
    await db.insert(billingRefunds).values({
      id: uniqueId('refund'), organizationId: orgId, requestedByUserId: requesterId,
      idempotencyKey: uniqueId('idem'), policyDecision: 'full_unused_pack', amountCents: 999, state: 'succeeded',
      createdAt: new Date('2031-09-15T00:00:00Z'), // outside the window below
    })

    const result = await getAccountingExport(deps({ windowStart: new Date('2031-08-01T00:00:00Z'), windowEnd: new Date('2031-09-01T00:00:00Z') }))

    expect(result.refunds.amountCents).toBe(500)
    expect(result.refunds.count).toBe(1)
  })
})

describe('getAccountingExport — disputes', () => {
  it('sums pack disputes inside the window and documents the subscription-dispute scope gap', async () => {
    const orgId = await freshOrg()
    const grantId = uniqueId('grant')
    await db.insert(billingCreditGrants).values({
      id: grantId, organizationId: orgId, source: 'pack', originalUnits: 300, remainingUnits: 0,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })
    await db.insert(billingDisputes).values({
      id: uniqueId('dispute'), organizationId: orgId, grantId, stripeDisputeId: uniqueId('dp'),
      stripePaymentIntentId: uniqueId('pi'), amountCents: 1500, stripeStatus: 'warning_needs_response',
      createdAt: new Date('2031-10-15T00:00:00Z'),
    })

    const result = await getAccountingExport(deps({ windowStart: new Date('2031-10-01T00:00:00Z'), windowEnd: new Date('2031-11-01T00:00:00Z') }))

    expect(result.disputes.amountCents).toBe(1500)
    expect(result.disputes.count).toBe(1)
    expect(result.disputes.scopeNote).toMatch(/pack/i)
  })
})

describe('getAccountingExport — fields with no real backing data', () => {
  it('never fabricates discounts, tax, Stripe fees, payout, or outstanding-invoice figures', async () => {
    const result = await getAccountingExport(deps({ windowStart: new Date('2031-11-01T00:00:00Z'), windowEnd: new Date('2031-12-01T00:00:00Z') }))

    expect(result.discounts).toEqual({ available: false, reason: expect.any(String) })
    expect(result.tax).toEqual({ available: false, reason: expect.any(String) })
    expect(result.stripeFees).toEqual({ available: false, reason: expect.any(String) })
    expect(result.payout).toEqual({ available: false, reason: expect.any(String) })
    expect(result.outstandingInvoices).toEqual({ available: false, reason: expect.any(String) })
    expect(result.providerCostByTierFeature).toEqual({ available: false, reason: expect.any(String) })
  })
})

describe('getAccountingExport — default window', () => {
  it('defaults to the previous full UTC calendar month relative to `now`', async () => {
    const result = await getAccountingExport(deps({ now: () => new Date('2026-08-15T12:00:00Z') }))

    expect(result.windowStart).toBe('2026-07-01T00:00:00.000Z')
    expect(result.windowEnd).toBe('2026-08-01T00:00:00.000Z')
  })
})

async function freshUserId(): Promise<string> {
  const userId = uniqueId('refund-requester')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  return userId
}

/**
 * plans/phase-3/12-bounded-reads-sweep: "an export missing its tail is a finding an auditor makes,
 * not a bug a user reports".
 *
 * The export used to read every refund, dispute and grant an organization had and reduce them in
 * JavaScript, which is unbounded but *complete*. Bounding it is the change that can quietly make it
 * incomplete, so this seeds far past any plausible page size and asserts the totals against
 * arithmetic rather than against a recorded snapshot — a snapshot would agree with a truncated
 * export the day someone re-recorded it.
 */
describe('getAccountingExport — completeness past one page', () => {
  const ROWS = 120

  it('covers every refund, dispute and grant in the window', async () => {
    const orgId = await freshOrg()
    const requesterId = await freshUserId()
    const windowStart = new Date('2032-01-01T00:00:00Z')
    const windowEnd = new Date('2032-02-01T00:00:00Z')

    // Disputes carry a NOT NULL grant reference. One grant with zero remaining units serves all of
    // them without touching the cross-organization credit-liability total.
    const grantId = uniqueId('grant')
    await db.insert(billingCreditGrants).values({
      id: grantId, organizationId: orgId, source: 'pack', originalUnits: 0, remainingUnits: 0,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })

    let expectedRefundCents = 0
    let expectedDisputeCents = 0
    for (let index = 0; index < ROWS; index += 1) {
      const amountCents = 100 + index
      expectedRefundCents += amountCents
      await db.insert(billingRefunds).values({
        id: uniqueId('refund'), organizationId: orgId, requestedByUserId: requesterId,
        idempotencyKey: uniqueId('idem'), policyDecision: 'full_unused_pack', amountCents, state: 'succeeded',
        createdAt: new Date(Date.UTC(2032, 0, 1 + (index % 28), 0, index % 60)),
      })

      const disputeCents = 200 + index
      expectedDisputeCents += disputeCents
      await db.insert(billingDisputes).values({
        id: uniqueId('dispute'), organizationId: orgId, grantId, stripeDisputeId: uniqueId('dp'),
        stripePaymentIntentId: uniqueId('pi'), amountCents: disputeCents, stripeStatus: 'needs_response',
        createdAt: new Date(Date.UTC(2032, 0, 1 + (index % 28), 1, index % 60)),
      })
    }

    const result = await getAccountingExport(deps({ windowStart, windowEnd }))

    expect(result.refunds.count).toBe(ROWS)
    expect(result.refunds.amountCents).toBe(expectedRefundCents)
    expect(result.disputes.count).toBe(ROWS)
    expect(result.disputes.amountCents).toBe(expectedDisputeCents)
  })
})
