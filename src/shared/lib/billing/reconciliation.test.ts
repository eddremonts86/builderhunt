import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import {
  authUsers,
  billingCreditGrants,
  billingCustomers,
  billingReconciliationRuns,
  billingSubscriptions,
  organizationMembers,
  organizations,
} from '../db/schema'
import { FakeBillingProvider } from './fake-provider'
import { findDuplicateProviderIds, runReconciliation } from './reconciliation'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `recon-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('reconciliation')
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

async function seedBillingCustomer(organizationId: string, stripeCustomerId: string): Promise<void> {
  await db.insert(billingCustomers).values({ id: uniqueId('cust-row'), organizationId, livemode: false, stripeCustomerId })
}

async function seedBillingSubscription(
  organizationId: string,
  stripeSubscriptionId: string,
  overrides: Partial<{ stripeStatus: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date }> = {},
): Promise<string> {
  const customerId = uniqueId('cust-row')
  await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
  await db.insert(billingSubscriptions).values({
    id: uniqueId('sub-row'), organizationId, customerId, livemode: false,
    catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId, stripeStatus: overrides.stripeStatus ?? 'active',
    cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: overrides.currentPeriodEnd ?? new Date('2026-04-01T00:00:00Z'),
  })
  return customerId
}

async function readSubscription(stripeSubscriptionId: string) {
  const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
  return row
}

function deps(provider: FakeBillingProvider, overrides: Partial<Parameters<typeof runReconciliation>[0]> = {}) {
  return { provider, worker: db, ...overrides }
}

describe('findDuplicateProviderIds', () => {
  it('finds ids appearing more than once', () => {
    expect(findDuplicateProviderIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }, { id: 'a' }])).toEqual(['a'])
  })

  it('returns empty when every id is unique', () => {
    expect(findDuplicateProviderIds([{ id: 'a' }, { id: 'b' }])).toEqual([])
  })
})

// This describe block deliberately runs FIRST among the integration tests (vitest executes tests
// within a file in declaration order) — it needs a still-pristine disposable database to assert a
// genuine "result: clean" run, and every other describe block below intentionally seeds
// missing/extra/stale fixtures that would otherwise make a global "clean" assertion permanently
// false once they've run.
describe('runReconciliation — persistence and result classification', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  it('writes a durable billing_reconciliation_runs row with result "clean" when nothing is wrong', async () => {
    const result = await runReconciliation(deps(provider))

    expect(result.result).toBe('clean')
    const [row] = await db.select().from(billingReconciliationRuns).where(eq(billingReconciliationRuns.id, result.id))
    expect(row).toBeDefined()
    expect(row.result).toBe('clean')
  })

  it('classifies as "mismatches_found" (not "repairs_applied") when mismatches exist with no auto-repair available', async () => {
    await provider.createCustomer({ email: 'f@test.com', idempotencyKey: uniqueId('idem') })

    const result = await runReconciliation(deps(provider))

    expect(result.result).toBe('mismatches_found')
  })
})

describe('runReconciliation — customers', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  it('detects a customer the provider has but we have no internal record for (missing_internal)', async () => {
    const customer = await provider.createCustomer({ email: 'a@test.com', idempotencyKey: uniqueId('idem') })

    const result = await runReconciliation(deps(provider))

    expect(result.mismatches).toContainEqual(expect.objectContaining({ type: 'missing_internal', objectType: 'customers', providerId: customer.id }))
  })

  it('detects a customer we have internally but the provider does not (extra_internal)', async () => {
    const orgId = await freshOrg()
    await seedBillingCustomer(orgId, 'cus_ghost_not_in_provider')

    const result = await runReconciliation(deps(provider))

    expect(result.mismatches).toContainEqual(expect.objectContaining({ type: 'extra_internal', objectType: 'customers', providerId: 'cus_ghost_not_in_provider' }))
  })

  it('reports clean for a specific customer when provider and internal agree exactly', async () => {
    // Every test in this file shares one disposable database, so a blanket "no mismatches at all"
    // assertion would be flaky against whatever other tests have already seeded — this asserts
    // THIS test's own customer id specifically is never flagged, which is the actual claim.
    const orgId = await freshOrg()
    const customer = await provider.createCustomer({ email: 'b@test.com', idempotencyKey: uniqueId('idem') })
    await seedBillingCustomer(orgId, customer.id)

    const result = await runReconciliation(deps(provider))

    expect(result.mismatches.filter((m) => m.providerId === customer.id)).toEqual([])
  })
})

describe('runReconciliation — subscriptions (stale + auto-repair)', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  it('detects a stale internal subscription and auto-repairs it by re-syncing from the provider', async () => {
    const orgId = await freshOrg()
    const stripeSubscriptionId = `sub_${uniqueId('sub')}`
    // Provider is authoritative: active, not scheduled to cancel.
    await provider.changeSubscription({ subscriptionId: stripeSubscriptionId, newPriceId: 'price_1', idempotencyKey: uniqueId('idem') })
    // Internal mirror is stale: says canceled.
    await seedBillingSubscription(orgId, stripeSubscriptionId, { stripeStatus: 'canceled', cancelAtPeriodEnd: true })

    const result = await runReconciliation(deps(provider))

    expect(result.mismatches).toContainEqual(expect.objectContaining({ type: 'stale_internal', objectType: 'subscriptions', providerId: stripeSubscriptionId }))
    expect(result.repairs).toContainEqual(expect.objectContaining({ objectType: 'subscriptions', providerId: stripeSubscriptionId }))
    expect(result.result).toBe('repairs_applied')

    const row = await readSubscription(stripeSubscriptionId)
    expect(row.stripeStatus).toBe('active')
    expect(row.cancelAtPeriodEnd).toBe(false)
  })

  it('a rerun after repair is a no-op — the same subscription is no longer flagged', async () => {
    const orgId = await freshOrg()
    const stripeSubscriptionId = `sub_${uniqueId('sub')}`
    await provider.changeSubscription({ subscriptionId: stripeSubscriptionId, newPriceId: 'price_1', idempotencyKey: uniqueId('idem') })
    await seedBillingSubscription(orgId, stripeSubscriptionId, { stripeStatus: 'canceled', cancelAtPeriodEnd: true })

    const first = await runReconciliation(deps(provider))
    expect(first.repairs.length).toBeGreaterThan(0)

    const second = await runReconciliation(deps(provider))

    expect(second.mismatches.filter((m) => m.providerId === stripeSubscriptionId)).toEqual([])
    expect(second.repairs).toEqual([])
  })

  it('detects a subscription the provider has but no internal ACTIVE row references (missing_internal)', async () => {
    const stripeSubscriptionId = `sub_${uniqueId('sub')}`
    await provider.changeSubscription({ subscriptionId: stripeSubscriptionId, newPriceId: 'price_1', idempotencyKey: uniqueId('idem') })

    const result = await runReconciliation(deps(provider))

    expect(result.mismatches).toContainEqual(expect.objectContaining({ type: 'missing_internal', objectType: 'subscriptions', providerId: stripeSubscriptionId }))
  })
})

describe('runReconciliation — refunds', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  it('detects a refund the provider has but we have no internal record for (missing_internal)', async () => {
    const customer = await provider.createCustomer({ email: 'c@test.com', idempotencyKey: uniqueId('idem') })
    const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: uniqueId('idem') })
    const refund = await provider.createRefund({ paymentIntentId: paymentIntent.id, idempotencyKey: uniqueId('idem') })

    const result = await runReconciliation(deps(provider))

    expect(result.mismatches).toContainEqual(expect.objectContaining({ type: 'missing_internal', objectType: 'refunds', providerId: refund.id }))
  })
})

describe('runReconciliation — payment_intents (existence only)', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  it('flags a SUCCEEDED payment_intent with no matching credit-grant record — the critical "money collected, no credits issued" case', async () => {
    const customer = await provider.createCustomer({ email: 'd@test.com', idempotencyKey: uniqueId('idem') })
    const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: uniqueId('idem') })

    const result = await runReconciliation(deps(provider))

    expect(result.mismatches).toContainEqual(expect.objectContaining({ type: 'missing_internal', objectType: 'payment_intents', providerId: paymentIntent.id }))
  })

  it('is silent when a credit grant already references the payment intent', async () => {
    const orgId = await freshOrg()
    const customer = await provider.createCustomer({ email: 'e@test.com', idempotencyKey: uniqueId('idem') })
    const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: uniqueId('idem') })
    await db.insert(billingCreditGrants).values({
      id: uniqueId('grant'), organizationId: orgId, source: 'pack', stripePaymentIntentId: paymentIntent.id,
      originalUnits: 300, remainingUnits: 300, expiresAt: new Date('2027-01-01T00:00:00Z'),
    })

    const result = await runReconciliation(deps(provider))

    expect(result.mismatches.filter((m) => m.objectType === 'payment_intents')).toEqual([])
  })
})

describe('runReconciliation — timeout and resume', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  it('stops after the current object type once the time budget is exhausted, and returns a resume cursor', async () => {
    const result = await runReconciliation(deps(provider, { maxDurationMs: 0 }))

    expect(result.resumeCursor).not.toBeNull()
    expect(Object.keys(result.countsChecked)).toEqual(['customers']) // only the first object type ran before the deadline check
  })

  it('does NOT persist a run row for a partial (resumed) pass — only the completing call does', async () => {
    const partial = await runReconciliation(deps(provider, { maxDurationMs: 0 }))
    expect(partial.resumeCursor).not.toBeNull()

    const rowsAfterPartial = await db.select().from(billingReconciliationRuns).where(eq(billingReconciliationRuns.id, partial.id))
    expect(rowsAfterPartial).toEqual([])
  })

  it('a resumed call continues from the cursor and eventually covers every object type', async () => {
    const partial = await runReconciliation(deps(provider, { maxDurationMs: 0 }))
    expect(partial.resumeCursor).toEqual({ objectType: 'subscriptions' })

    const completed = await runReconciliation(deps(provider, { resumeFrom: partial.resumeCursor }))

    expect(completed.resumeCursor).toBeNull()
    expect(Object.keys(completed.countsChecked).sort()).toEqual(['payment_intents', 'refunds', 'subscriptions'])
    const [row] = await db.select().from(billingReconciliationRuns).where(eq(billingReconciliationRuns.id, completed.id))
    expect(row).toBeDefined()
  })
})
