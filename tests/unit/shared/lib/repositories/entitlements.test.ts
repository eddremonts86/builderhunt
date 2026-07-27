import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { billingCustomers, billingSubscriptions, organizationEntitlements, organizations } from '~/shared/lib/db/schema'
import { getOrganizationEntitlement, resolveEntitlementPolicy, resolveLegacyPlanTier } from '~/shared/lib/repositories/entitlements'

describe('organization entitlement policy', () => {
  it('defaults a missing entitlement to the free plan', () => {
    expect(resolveEntitlementPolicy(null)).toMatchObject({ tier: 'free', active: true, seatLimit: 1 })
  })

  it('keeps data readable but denies paid actions for inactive plans', () => {
    const policy = resolveEntitlementPolicy({ tier: 'team', status: 'past_due', seatLimit: 10 })
    expect(policy).toMatchObject({ tier: 'team', active: false, paidActionsAllowed: false, seatLimit: 10 })
  })

  it('uses the selected organization row rather than user identity', () => {
    const personal = resolveEntitlementPolicy({ tier: 'pro', status: 'active', seatLimit: 1 })
    const team = resolveEntitlementPolicy({ tier: 'team', status: 'active', seatLimit: 10 })
    expect(personal.tier).toBe('pro')
    expect(team.tier).toBe('team')
  })

  it('accepts the Stripe-native pro_max tier (only projectSubscriptionEntitlement writes it, never a manual grant)', () => {
    const policy = resolveEntitlementPolicy({ tier: 'pro_max', status: 'active', seatLimit: 1 })
    expect(policy).toMatchObject({ tier: 'pro_max', active: true, paidActionsAllowed: true, seatLimit: 1 })
  })

  it('rejects an invalid tier string', () => {
    expect(() => resolveEntitlementPolicy({ tier: 'bogus', status: 'active', seatLimit: 1 })).toThrow()
  })

  it('denies paid actions when payment-blocked, even for an otherwise-active paid tier (§7 task 6 dunning)', () => {
    const policy = resolveEntitlementPolicy({ tier: 'team', status: 'active', seatLimit: 10 }, true)
    expect(policy).toMatchObject({ tier: 'team', status: 'active', active: true, paidActionsAllowed: false, paymentBlocked: true })
  })

  it('defaults paymentBlocked to false when not specified', () => {
    expect(resolveEntitlementPolicy({ tier: 'pro', status: 'active', seatLimit: 1 })).toMatchObject({ paymentBlocked: false, paidActionsAllowed: true })
  })

  it('a payment-blocked free-tier organization stays denied for the same reason as before (tier, not the block)', () => {
    expect(resolveEntitlementPolicy(null, true)).toMatchObject({ tier: 'free', paidActionsAllowed: false, paymentBlocked: true })
  })
})

describe('resolveLegacyPlanTier', () => {
  it('passes free/pro/team through unchanged', () => {
    expect(resolveLegacyPlanTier('free')).toBe('free')
    expect(resolveLegacyPlanTier('pro')).toBe('pro')
    expect(resolveLegacyPlanTier('team')).toBe('team')
  })

  it('maps pro_max to team — the most generous existing legacy tier, until a Pro-Max-specific entry is designed', () => {
    expect(resolveLegacyPlanTier('pro_max')).toBe('team')
  })
})

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `entitlements-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('entitlements')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

describe('getOrganizationEntitlement — payment-blocked join', () => {
  async function seedOrganizationWithSubscription(overrides: { tier?: string; paymentBlockedAt?: Date | null } = {}): Promise<string> {
    const organizationId = uniqueId('org')
    await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
    await db.insert(organizationEntitlements).values({
      organizationId, tier: overrides.tier ?? 'team', status: 'active', billingPeriod: 'monthly', seatLimit: 10,
    })
    const customerId = uniqueId('cust')
    await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
    await db.insert(billingSubscriptions).values({
      id: uniqueId('subrow'), organizationId, customerId, livemode: false,
      catalogKey: 'team_monthly', tier: 'team', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: `sub_${uniqueId('sub')}`, stripeStatus: 'active',
      paymentBlockedAt: overrides.paymentBlockedAt ?? null,
      providerSyncedAt: new Date('2026-01-01T00:00:00Z'),
    })
    return organizationId
  }

  it('is not payment-blocked when no subscription row has paymentBlockedAt set', async () => {
    const organizationId = await seedOrganizationWithSubscription()
    const policy = await db.transaction((tx) => getOrganizationEntitlement(tx, organizationId))
    expect(policy).toMatchObject({ paymentBlocked: false, paidActionsAllowed: true })
  })

  it('denies paid actions once the subscription is payment-blocked, even though status is still active', async () => {
    const organizationId = await seedOrganizationWithSubscription({ paymentBlockedAt: new Date('2026-01-08T00:00:00Z') })
    const policy = await db.transaction((tx) => getOrganizationEntitlement(tx, organizationId))
    expect(policy).toMatchObject({ tier: 'team', status: 'active', paymentBlocked: true, paidActionsAllowed: false })
  })

  it('ignores a payment-blocked flag on an already-canceled subscription row (organization moved on)', async () => {
    const organizationId = uniqueId('org')
    await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
    await db.insert(organizationEntitlements).values({
      organizationId, tier: 'team', status: 'active', billingPeriod: 'monthly', seatLimit: 10,
    })
    const customerId = uniqueId('cust')
    await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
    await db.insert(billingSubscriptions).values({
      id: uniqueId('subrow'), organizationId, customerId, livemode: false,
      catalogKey: 'team_monthly', tier: 'team', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: `sub_${uniqueId('sub')}`, stripeStatus: 'canceled',
      paymentBlockedAt: new Date('2026-01-08T00:00:00Z'),
      canceledAt: new Date('2026-01-10T00:00:00Z'),
      providerSyncedAt: new Date('2026-01-01T00:00:00Z'),
    })

    const policy = await db.transaction((tx) => getOrganizationEntitlement(tx, organizationId))
    expect(policy.paymentBlocked).toBe(false)
  })
})

describe('getOrganizationEntitlement — no subscription row at all', () => {
  it('is never payment-blocked for an organization with no billing_subscriptions row', async () => {
    const organizationId = uniqueId('org')
    await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })

    const policy = await db.transaction((tx) => getOrganizationEntitlement(tx, organizationId))
    expect(policy).toMatchObject({ tier: 'free', paymentBlocked: false })
  })
})
