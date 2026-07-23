import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingAutoRechargeRules, billingCreditGrants, organizationMembers, organizations } from '../db/schema'
import { createBillingCustomer, createBillingSubscription } from '../repositories/billing'
import {
  configureAutoRecharge,
  disableAutoRecharge,
  getAutoRechargeRuleForOwner,
  maybeTriggerAutoRecharge,
} from './auto-recharge'
import { PACK_CATALOG } from './catalog'
import { FakeBillingProvider } from './fake-provider'
import type { CreateSetupIntentInput, SetupIntentResult } from './provider'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `autorecharge-${label}-${counter}`
}

async function freshOrgWithOwner(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizationMembers).values({ id: uniqueId('member'), organizationId: orgId, userId, role: 'owner', createdAt: new Date() })
  return { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

async function grantActiveSubscription(organizationId: string, stripeStatus = 'active'): Promise<void> {
  const customerId = uniqueId('customer')
  await db.transaction((tx) => createBillingCustomer(tx, { id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` }))
  await db.transaction((tx) => createBillingSubscription(tx, {
    id: uniqueId('sub'), organizationId, customerId, livemode: false,
    catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus,
  }))
}

async function seedGrant(organizationId: string, source: string, sourceReference: string, stripePaymentReference: string, createdAt: Date): Promise<void> {
  await db.insert(billingCreditGrants).values({
    id: uniqueId('grant'), organizationId, source, sourceReference, stripePaymentReference,
    originalUnits: 1, remainingUnits: 1, expiresAt: new Date('2099-01-01T00:00:00Z'), createdAt,
  })
}

async function readRule(organizationId: string) {
  const [row] = await db.select().from(billingAutoRechargeRules).where(eq(billingAutoRechargeRules.organizationId, organizationId))
  return row ?? null
}

class RequiresActionSetupProvider extends FakeBillingProvider {
  override async createSetupIntent(input: CreateSetupIntentInput): Promise<SetupIntentResult> {
    return { id: `seti_${input.idempotencyKey}`, clientSecret: 'secret', status: 'requires_action' }
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('autorecharge')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

const BASE_CONFIG = {
  packCatalogKey: 'starter_300',
  balanceThresholdUnits: 50,
  monthlyCapCents: 10_000,
  acknowledgedOffSessionCharge: true,
}

describe('configureAutoRecharge', () => {
  let provider: FakeBillingProvider

  beforeEach(() => {
    provider = new FakeBillingProvider()
  })

  it('rejects a negative balanceThresholdUnits', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)

    await expect(db.transaction((tx) => configureAutoRecharge(tx, principal, { ...BASE_CONFIG, balanceThresholdUnits: -1 }, { provider })))
      .rejects.toMatchObject({ code: 'invalid_threshold' })
  })

  it('rejects a monthlyCapCents above the $1,000 ceiling', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)

    await expect(db.transaction((tx) => configureAutoRecharge(tx, principal, { ...BASE_CONFIG, monthlyCapCents: 100_001 }, { provider })))
      .rejects.toMatchObject({ code: 'invalid_monthly_cap' })
  })

  it('rejects a zero or negative monthlyCapCents', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)

    await expect(db.transaction((tx) => configureAutoRecharge(tx, principal, { ...BASE_CONFIG, monthlyCapCents: 0 }, { provider })))
      .rejects.toMatchObject({ code: 'invalid_monthly_cap' })
  })

  it('rejects an unknown pack catalog key', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)

    await expect(db.transaction((tx) => configureAutoRecharge(tx, principal, { ...BASE_CONFIG, packCatalogKey: 'not_a_real_pack' }, { provider })))
      .rejects.toMatchObject({ code: 'unknown_pack_catalog_key' })
  })

  it('rejects when the organization has no active paid subscription', async () => {
    const principal = await freshOrgWithOwner()

    await expect(db.transaction((tx) => configureAutoRecharge(tx, principal, BASE_CONFIG, { provider })))
      .rejects.toMatchObject({ code: 'no_active_subscription' })
  })

  it('rejects when the saved payment method needs additional authentication (SetupIntent requires_action)', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)

    await expect(db.transaction((tx) => configureAutoRecharge(tx, principal, BASE_CONFIG, { provider: new RequiresActionSetupProvider() })))
      .rejects.toMatchObject({ code: 'setup_requires_action' })

    expect(await readRule(principal.organizationId)).toBeNull()
  })

  it('enables the rule and stores the configuration on success', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)

    const rule = await db.transaction((tx) => configureAutoRecharge(tx, principal, BASE_CONFIG, { provider }))

    expect(rule.enabled).toBe(true)
    expect(rule.state).toBe('active')
    expect(rule.packCatalogKey).toBe('starter_300')
    expect(rule.balanceThresholdUnits).toBe(50)
    expect(rule.monthlyCapCents).toBe(10_000)
    expect(rule.pendingPaymentIntentId).toBeNull()
  })

  it('reconfiguring clears a stale failure/pending marker from before', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)
    await db.transaction((tx) => configureAutoRecharge(tx, principal, BASE_CONFIG, { provider }))
    await db.update(billingAutoRechargeRules)
      .set({ state: 'paused_failed', lastFailureAt: new Date(), lastFailureReason: 'stale failure', pendingPaymentIntentId: 'pi_stale' })
      .where(eq(billingAutoRechargeRules.organizationId, principal.organizationId))

    const rule = await db.transaction((tx) => configureAutoRecharge(tx, principal, BASE_CONFIG, { provider }))

    expect(rule.state).toBe('active')
    expect(rule.lastFailureAt).toBeNull()
    expect(rule.lastFailureReason).toBeNull()
    expect(rule.pendingPaymentIntentId).toBeNull()
  })
})

describe('disableAutoRecharge / getAutoRechargeRuleForOwner', () => {
  it('returns null when never configured', async () => {
    const principal = await freshOrgWithOwner()
    expect(await db.transaction((tx) => getAutoRechargeRuleForOwner(tx, principal))).toBeNull()
  })

  it('disable turns off an active rule without discarding its configuration', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)
    const provider = new FakeBillingProvider()
    await db.transaction((tx) => configureAutoRecharge(tx, principal, BASE_CONFIG, { provider }))

    const disabled = await db.transaction((tx) => disableAutoRecharge(tx, principal))

    expect(disabled?.enabled).toBe(false)
    expect(disabled?.state).toBe('inactive')
    expect(disabled?.packCatalogKey).toBe('starter_300')
    expect(disabled?.balanceThresholdUnits).toBe(50)
  })
})

describe('maybeTriggerAutoRecharge', () => {
  let provider: FakeBillingProvider

  beforeEach(() => {
    provider = new FakeBillingProvider()
  })

  async function configuredOrg(overrides: Partial<typeof BASE_CONFIG> = {}): Promise<TenantPrincipal> {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)
    await db.transaction((tx) => configureAutoRecharge(tx, principal, { ...BASE_CONFIG, ...overrides }, { provider }))
    return principal
  }

  it('does not trigger when no rule exists', async () => {
    const principal = await freshOrgWithOwner()
    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider }))
    expect(outcome.triggered).toBe(false)
  })

  it('does not trigger when disabled', async () => {
    const principal = await configuredOrg()
    await db.transaction((tx) => disableAutoRecharge(tx, principal))

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider }))
    expect(outcome.triggered).toBe(false)
  })

  it('does not trigger when a charge is already in flight', async () => {
    const principal = await configuredOrg()
    await db.update(billingAutoRechargeRules).set({ pendingPaymentIntentId: 'pi_in_flight' }).where(eq(billingAutoRechargeRules.organizationId, principal.organizationId))

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider }))
    expect(outcome).toEqual({ triggered: false, reason: 'a charge is already in flight' })
  })

  it('does not trigger when the balance is above the configured threshold', async () => {
    const principal = await configuredOrg({ balanceThresholdUnits: 5 })
    await seedGrant(principal.organizationId, 'subscription_monthly', 'pro_monthly', 'in_x', new Date())
    await db.update(billingCreditGrants).set({ remainingUnits: 100, originalUnits: 100 }).where(eq(billingCreditGrants.organizationId, principal.organizationId))

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider }))
    expect(outcome).toEqual({ triggered: false, reason: 'balance is above the configured threshold' })
  })

  it('triggers and claims a PaymentIntent when the balance is at or below threshold', async () => {
    const principal = await configuredOrg({ balanceThresholdUnits: 50 })

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider }))

    expect(outcome.triggered).toBe(true)
    if (!outcome.triggered) throw new Error('expected triggered')
    const rule = await readRule(principal.organizationId)
    expect(rule?.pendingPaymentIntentId).toBe(outcome.paymentIntentId)
    const paymentIntent = await provider.refreshObject('payment_intent', outcome.paymentIntentId)
    expect(paymentIntent).toMatchObject({ amount: PACK_CATALOG.starter_300.amountCents })
  })

  it('pauses the rule when the configured pack catalog key no longer resolves', async () => {
    const principal = await configuredOrg()
    await db.update(billingAutoRechargeRules).set({ packCatalogKey: 'retired_pack_xyz' }).where(eq(billingAutoRechargeRules.organizationId, principal.organizationId))

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider }))

    expect(outcome.triggered).toBe(false)
    const rule = await readRule(principal.organizationId)
    expect(rule?.state).toBe('paused_failed')
    expect(rule?.lastFailureReason).toMatch(/no longer available/)
  })

  it('does not trigger when the subscription has lapsed', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId, 'past_due')
    await db.insert(billingAutoRechargeRules).values({
      organizationId: principal.organizationId, ownerUserId: principal.userId, enabled: true,
      packCatalogKey: 'starter_300', balanceThresholdUnits: 50, monthlyCapCents: 10_000, state: 'active',
    })

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider }))
    expect(outcome).toEqual({ triggered: false, reason: 'no active paid subscription' })
  })

  it('does not trigger and does not pause when the shared rolling risk limit is already hit', async () => {
    const principal = await configuredOrg()
    const now = new Date()
    for (let i = 0; i < 3; i += 1) {
      await seedGrant(principal.organizationId, 'pack', 'starter_300', `cs_manual_${i}`, now)
    }

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider, now }))

    expect(outcome).toEqual({ triggered: false, reason: 'shared rolling 24h risk limit reached' })
    const rule = await readRule(principal.organizationId)
    expect(rule?.state).toBe('active') // temporary condition — never paused
  })

  it('does not trigger once the monthly auto-recharge cap is reached, counting only pi_-prefixed grants', async () => {
    const principal = await configuredOrg({ monthlyCapCents: PACK_CATALOG.starter_300.amountCents })
    const now = new Date('2026-03-15T00:00:00Z')
    // One prior auto-recharge charge this month already consumed the entire cap.
    await seedGrant(principal.organizationId, 'pack', 'starter_300', 'pi_prior_auto', new Date('2026-03-01T00:00:00Z'))

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider, now }))
    expect(outcome).toEqual({ triggered: false, reason: 'monthly auto-recharge cap reached' })
  })

  it('a manually-purchased pack (cs_-prefixed reference) does not count against the monthly auto-recharge cap', async () => {
    const principal = await configuredOrg({ monthlyCapCents: PACK_CATALOG.starter_300.amountCents })
    const now = new Date('2026-03-15T00:00:00Z')
    await seedGrant(principal.organizationId, 'pack', 'starter_300', 'cs_manual_purchase', new Date('2026-03-01T00:00:00Z'))

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider, now }))
    expect(outcome.triggered).toBe(true)
  })

  it('pauses the rule when the off-session charge is declined', async () => {
    class DeclineProvider extends FakeBillingProvider {
      override async createPaymentIntent(): Promise<never> {
        throw Object.assign(new Error('Your card was declined.'), { scenario: 'decline' })
      }
    }
    const principal = await configuredOrg()

    const outcome = await db.transaction((tx) => maybeTriggerAutoRecharge(tx, principal.organizationId, { provider: new DeclineProvider() }))

    expect(outcome).toEqual({ triggered: false, reason: 'provider declined the off-session charge' })
    const rule = await readRule(principal.organizationId)
    expect(rule?.state).toBe('paused_failed')
    expect(rule?.pendingPaymentIntentId).toBeNull()
  })
})
