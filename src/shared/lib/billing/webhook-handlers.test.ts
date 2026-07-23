import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingAutoRechargeRules, billingCheckoutAttempts, billingCreditGrants, billingCustomers, billingSubscriptions, organizationEntitlements, organizations } from '../db/schema'
import { computeAnniversary } from './annual-grants'
import { PACK_CATALOG, SUBSCRIPTION_CATALOG } from './catalog'
import { processStripeWebhookEvent } from './webhook-handlers'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `whh-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('webhook_handlers')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

async function seedOrganization(): Promise<{ organizationId: string; userId: string }> {
  const organizationId = uniqueId('org')
  await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  return { organizationId, userId }
}

async function seedCustomer(organizationId: string, livemode = false): Promise<string> {
  const customerId = uniqueId('cust')
  const stripeCustomerId = `cus_${customerId}`
  await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode, stripeCustomerId })
  return stripeCustomerId
}

async function seedAutoRechargeRule(organizationId: string, userId: string, pendingPaymentIntentId: string): Promise<void> {
  await db.insert(billingAutoRechargeRules).values({
    organizationId, ownerUserId: userId, enabled: true, packCatalogKey: 'starter_300',
    balanceThresholdUnits: 50, monthlyCapCents: 10_000, state: 'active', pendingPaymentIntentId,
  })
}

function paymentIntentEvent(
  id: string,
  paymentIntentId: string,
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed' | 'payment_intent.requires_action',
  created = 1780000000,
) {
  return {
    id, type, created, livemode: false, api_version: '2026-06-24.dahlia',
    data: { object: { id: paymentIntentId, object: 'payment_intent' } },
  } as unknown as Parameters<typeof processStripeWebhookEvent>[0]
}

async function readEntitlement(organizationId: string) {
  const [row] = await db.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, organizationId)).limit(1)
  return row ?? null
}

async function seedCheckoutAttempt(
  organizationId: string,
  userId: string,
  stripeCheckoutSessionId: string,
  overrides: Partial<{ action: 'subscription' | 'credits'; catalogKey: string }> = {},
): Promise<string> {
  const id = uniqueId('attempt')
  await db.insert(billingCheckoutAttempts).values({
    id, organizationId, actorUserId: userId, livemode: false, action: overrides.action ?? 'subscription',
    catalogKey: overrides.catalogKey ?? 'pro_monthly', idempotencyKey: uniqueId('idem'), consentVersions: { terms: 'v1.0', privacy: 'v1.0' },
    stripeCheckoutSessionId, expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return id
}

async function seedSubscription(
  organizationId: string,
  customerId: string,
  overrides: Partial<{ stripeSubscriptionId: string; stripeStatus: string; providerSyncedAt: Date; catalogKey: string; tier: string; interval: string; currentPeriodStart: Date; currentPeriodEnd: Date }> = {},
): Promise<string> {
  const stripeSubscriptionId = overrides.stripeSubscriptionId ?? `sub_${uniqueId('sub')}`
  await db.insert(billingSubscriptions).values({
    id: uniqueId('subrow'), organizationId, customerId, livemode: false,
    catalogKey: overrides.catalogKey ?? 'pro_monthly', tier: overrides.tier ?? 'pro', interval: overrides.interval ?? 'monthly', catalogVersion: 1,
    stripeSubscriptionId, stripeStatus: overrides.stripeStatus ?? 'active',
    currentPeriodStart: overrides.currentPeriodStart ?? null,
    currentPeriodEnd: overrides.currentPeriodEnd ?? null,
    providerSyncedAt: overrides.providerSyncedAt ?? new Date('2026-01-01T00:00:00Z'),
  })
  return stripeSubscriptionId
}

function checkoutSessionEvent(
  id: string,
  sessionId: string,
  type: 'checkout.session.completed' | 'checkout.session.expired',
  created = 1780000000,
  mode: 'subscription' | 'payment' = 'subscription',
) {
  return {
    id, type, created, livemode: false, api_version: '2026-06-24.dahlia',
    data: { object: { id: sessionId, object: 'checkout.session', mode } },
  } as unknown as Parameters<typeof processStripeWebhookEvent>[0]
}

function subscriptionEvent(
  id: string,
  type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted',
  input: {
    subscriptionId: string
    customerId: string
    priceId?: string
    status: string
    currentPeriodStart?: number
    currentPeriodEnd?: number
    cancelAtPeriodEnd?: boolean
    canceledAt?: number | null
    created: number
  },
) {
  return {
    id, type, created: input.created, livemode: false, api_version: '2026-06-24.dahlia',
    data: {
      object: {
        id: input.subscriptionId,
        object: 'subscription',
        customer: input.customerId,
        status: input.status,
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
        canceled_at: input.canceledAt ?? null,
        items: { data: [{ price: { id: input.priceId ?? SUBSCRIPTION_CATALOG.pro_monthly.stripePriceId.test }, current_period_start: input.currentPeriodStart ?? input.created, current_period_end: input.currentPeriodEnd ?? input.created + 30 * 24 * 60 * 60 }] },
      },
    },
  } as unknown as Parameters<typeof processStripeWebhookEvent>[0]
}

function invoiceEvent(
  id: string,
  type: 'invoice.paid' | 'invoice.payment_failed',
  input: { invoiceId: string; subscriptionId: string; periodEnd?: number; created: number },
) {
  return {
    id, type, created: input.created, livemode: false, api_version: '2026-06-24.dahlia',
    data: {
      object: {
        id: input.invoiceId,
        object: 'invoice',
        period_end: input.periodEnd ?? input.created + 30 * 24 * 60 * 60,
        parent: { subscription_details: { subscription: input.subscriptionId } },
      },
    },
  } as unknown as Parameters<typeof processStripeWebhookEvent>[0]
}

describe('processStripeWebhookEvent — checkout session', () => {
  it('marks a checkout attempt complete', async () => {
    const { organizationId, userId } = await seedOrganization()
    const sessionId = `cs_${uniqueId('session')}`
    await seedCheckoutAttempt(organizationId, userId, sessionId)

    const result = await processStripeWebhookEvent(checkoutSessionEvent(uniqueId('evt'), sessionId, 'checkout.session.completed'), { db })

    expect(result.outcome).toBe('applied')
    const [attempt] = await db.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.stripeCheckoutSessionId, sessionId))
    expect(attempt.status).toBe('complete')
  })

  it('marks a checkout attempt expired', async () => {
    const { organizationId, userId } = await seedOrganization()
    const sessionId = `cs_${uniqueId('session')}`
    await seedCheckoutAttempt(organizationId, userId, sessionId)

    await processStripeWebhookEvent(checkoutSessionEvent(uniqueId('evt'), sessionId, 'checkout.session.expired'), { db })

    const [attempt] = await db.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.stripeCheckoutSessionId, sessionId))
    expect(attempt.status).toBe('expired')
  })

  it('duplicate delivery of the same checkout event is a safe no-op — status never regresses', async () => {
    const { organizationId, userId } = await seedOrganization()
    const sessionId = `cs_${uniqueId('session')}`
    await seedCheckoutAttempt(organizationId, userId, sessionId)

    const event = checkoutSessionEvent(uniqueId('evt'), sessionId, 'checkout.session.completed')
    await processStripeWebhookEvent(event, { db })
    const second = await processStripeWebhookEvent(event, { db })

    expect(second.outcome).toBe('applied')
    const [attempt] = await db.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.stripeCheckoutSessionId, sessionId))
    expect(attempt.status).toBe('complete')
  })

  it('defers when no matching checkout attempt exists yet', async () => {
    const result = await processStripeWebhookEvent(checkoutSessionEvent(uniqueId('evt'), 'cs_never_seen', 'checkout.session.completed'), { db })
    expect(result.outcome).toBe('deferred')
  })
})

describe('processStripeWebhookEvent — subscription created/updated', () => {
  it('creates a billing_subscriptions row on first sighting, resolving tier/interval/catalogKey from the Price ID', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const subscriptionId = `sub_${uniqueId('sub')}`

    const result = await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.created', {
        subscriptionId, customerId: stripeCustomerId, status: 'active', created: 1780000000,
        priceId: SUBSCRIPTION_CATALOG.team_monthly.stripePriceId.test!,
      }),
      { db },
    )

    expect(result.outcome).toBe('applied')
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(row.catalogKey).toBe('team_monthly')
    expect(row.tier).toBe('team')
    expect(row.interval).toBe('monthly')
    expect(row.stripeStatus).toBe('active')

    const entitlement = await readEntitlement(organizationId)
    expect(entitlement).toMatchObject({ tier: 'team', status: 'active', billingPeriod: 'monthly', seatLimit: 10 })
  })

  it('projects a pro_max entitlement on first sighting (requires the widened tier CHECK constraint)', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const subscriptionId = `sub_${uniqueId('sub')}`

    await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.created', {
        subscriptionId, customerId: stripeCustomerId, status: 'active', created: 1780000000,
        priceId: SUBSCRIPTION_CATALOG.pro_max_monthly.stripePriceId.test!,
      }),
      { db },
    )

    const entitlement = await readEntitlement(organizationId)
    expect(entitlement).toMatchObject({ tier: 'pro_max', status: 'active', seatLimit: 1 })
  })

  it('does not project an entitlement for an incomplete (never-paid) subscription', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const subscriptionId = `sub_${uniqueId('sub')}`

    await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.created', {
        subscriptionId, customerId: stripeCustomerId, status: 'incomplete', created: 1780000000,
      }),
      { db },
    )

    expect(await readEntitlement(organizationId)).toBeNull()
  })

  it('applies a newer status update on an existing subscription and re-projects the entitlement in the same transaction', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { stripeStatus: 'active', providerSyncedAt: new Date('2026-01-01T00:00:00Z') })

    const result = await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.updated', {
        subscriptionId, customerId: stripeCustomerId, status: 'past_due', created: Math.floor(new Date('2026-01-02T00:00:00Z').getTime() / 1000),
      }),
      { db },
    )

    expect(result.outcome).toBe('applied')
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(row.stripeStatus).toBe('past_due')

    const entitlement = await readEntitlement(organizationId)
    expect(entitlement).toMatchObject({ tier: 'pro', status: 'past_due' })
  })

  it('rejects a stale (delayed/out-of-order) status update older than the current state', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { stripeStatus: 'active', providerSyncedAt: new Date('2026-01-05T00:00:00Z') })

    const result = await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.updated', {
        subscriptionId, customerId: stripeCustomerId, status: 'past_due', created: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000),
      }),
      { db },
    )

    expect(result.outcome).toBe('ignored')
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(row.stripeStatus).toBe('active')
  })

  it('a reversed-order permutation converges on the newest event winning, regardless of delivery order', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { stripeStatus: 'active', providerSyncedAt: new Date('2026-01-01T00:00:00Z') })

    const t1 = Math.floor(new Date('2026-01-02T00:00:00Z').getTime() / 1000)
    const t2 = Math.floor(new Date('2026-01-03T00:00:00Z').getTime() / 1000)

    // Deliver the NEWER event (t2) first, then the OLDER one (t1) — simulating out-of-order delivery.
    await processStripeWebhookEvent(subscriptionEvent(uniqueId('evt'), 'customer.subscription.updated', { subscriptionId, customerId: stripeCustomerId, status: 'past_due', created: t2 }), { db })
    const laterDeliveredOlderEvent = await processStripeWebhookEvent(subscriptionEvent(uniqueId('evt'), 'customer.subscription.updated', { subscriptionId, customerId: stripeCustomerId, status: 'active', created: t1 }), { db })

    expect(laterDeliveredOlderEvent.outcome).toBe('ignored')
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(row.stripeStatus).toBe('past_due')
  })

  it('duplicate delivery of the identical event is idempotent — same final state, no error', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { stripeStatus: 'active', providerSyncedAt: new Date('2026-01-01T00:00:00Z') })

    const event = subscriptionEvent(uniqueId('evt'), 'customer.subscription.updated', {
      subscriptionId, customerId: stripeCustomerId, status: 'past_due', created: Math.floor(new Date('2026-01-02T00:00:00Z').getTime() / 1000),
    })
    const first = await processStripeWebhookEvent(event, { db })
    const second = await processStripeWebhookEvent(event, { db })

    expect(first.outcome).toBe('applied')
    expect(second.outcome).toBe('applied')
    const rows = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(rows).toHaveLength(1)
    expect(rows[0].stripeStatus).toBe('past_due')
  })

  it('locks out further updates once a subscription is canceled — never un-cancels', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { stripeStatus: 'canceled', providerSyncedAt: new Date('2026-01-01T00:00:00Z') })

    const result = await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.updated', {
        subscriptionId, customerId: stripeCustomerId, status: 'active', created: Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000),
      }),
      { db },
    )

    expect(result.outcome).toBe('ignored')
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(row.stripeStatus).toBe('canceled')
  })

  it('defers when the organization cannot be resolved yet (no customer row)', async () => {
    const result = await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.created', {
        subscriptionId: `sub_${uniqueId('sub')}`, customerId: 'cus_never_seen', status: 'active', created: 1780000000,
      }),
      { db },
    )
    expect(result.outcome).toBe('deferred')
  })

  it('recovering to active clears a payment block and unfreezes still-valid grants (§7 task 6 dunning recovery)', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { stripeStatus: 'past_due', providerSyncedAt: new Date('2026-01-01T00:00:00Z') })
    await db.update(billingSubscriptions)
      .set({ gracePeriodEndsAt: new Date('2026-01-08T00:00:00Z'), paymentBlockedAt: new Date('2026-01-08T00:00:00Z') })
      .where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    const grantId = uniqueId('grant')
    await db.insert(billingCreditGrants).values({
      id: grantId, organizationId, source: 'subscription_monthly', sourceReference: subscriptionId,
      originalUnits: 100, remainingUnits: 100, state: 'frozen', expiresAt: new Date('2027-01-01T00:00:00Z'),
    })

    const result = await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.updated', {
        subscriptionId, customerId: stripeCustomerId, status: 'active', created: Math.floor(new Date('2026-01-10T00:00:00Z').getTime() / 1000),
      }),
      { db },
    )

    expect(result.outcome).toBe('applied')
    const [subscriptionRow] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(subscriptionRow.paymentBlockedAt).toBeNull()
    expect(subscriptionRow.gracePeriodEndsAt).toBeNull()
    const [grantRow] = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.id, grantId))
    expect(grantRow.state).toBe('active')
  })
})

describe('processStripeWebhookEvent — subscription deleted', () => {
  it('marks the subscription canceled', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { stripeStatus: 'active', providerSyncedAt: new Date('2026-01-01T00:00:00Z') })

    const result = await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.deleted', {
        subscriptionId, customerId: stripeCustomerId, status: 'canceled', created: Math.floor(new Date('2026-01-02T00:00:00Z').getTime() / 1000),
      }),
      { db },
    )

    expect(result.outcome).toBe('applied')
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(row.stripeStatus).toBe('canceled')
    expect(row.canceledAt).not.toBeNull()

    const entitlement = await readEntitlement(organizationId)
    expect(entitlement).toMatchObject({ tier: 'pro', status: 'canceled' })
  })
})

describe('processStripeWebhookEvent — invoice.paid', () => {
  it('grants the monthly credit allowance for the subscription\'s catalog key', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })
    const invoiceId = `in_${uniqueId('invoice')}`

    const result = await processStripeWebhookEvent(
      invoiceEvent(uniqueId('evt'), 'invoice.paid', { invoiceId, subscriptionId, created: 1780000000 }),
      { db },
    )

    expect(result.outcome).toBe('applied')
    const grants = await db.select().from(billingCreditGrants).where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.stripePaymentReference, invoiceId)))
    expect(grants).toHaveLength(1)
    expect(grants[0].originalUnits).toBe(SUBSCRIPTION_CATALOG.pro_monthly.monthlyCredits)
  })

  it('duplicate delivery of the same invoice grants credits exactly once', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id)
    const invoiceId = `in_${uniqueId('invoice')}`
    const event = invoiceEvent(uniqueId('evt'), 'invoice.paid', { invoiceId, subscriptionId, created: 1780000000 })

    await processStripeWebhookEvent(event, { db })
    const second = await processStripeWebhookEvent(event, { db })

    expect(second.outcome).toBe('applied')
    const grants = await db.select().from(billingCreditGrants).where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.stripePaymentReference, invoiceId)))
    expect(grants).toHaveLength(1)
  })

  it('an annual subscription\'s first invoice expires at the first monthly anniversary, not the full year — the remaining 11 windows are the worker\'s job', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const currentPeriodStart = new Date('2026-01-31T00:00:00Z')
    const currentPeriodEnd = new Date('2027-01-31T00:00:00Z')
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, {
      catalogKey: 'pro_max_annual', tier: 'pro_max', interval: 'annual', currentPeriodStart, currentPeriodEnd,
    })
    const invoiceId = `in_${uniqueId('invoice')}`

    await processStripeWebhookEvent(
      invoiceEvent(uniqueId('evt'), 'invoice.paid', { invoiceId, subscriptionId, periodEnd: Math.floor(currentPeriodEnd.getTime() / 1000), created: Math.floor(currentPeriodStart.getTime() / 1000) }),
      { db },
    )

    const [grant] = await db.select().from(billingCreditGrants).where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.stripePaymentReference, invoiceId)))
    expect(grant.expiresAt.toISOString()).toBe(new Date('2026-02-28T00:00:00Z').toISOString())
    expect(grant.originalUnits).toBe(SUBSCRIPTION_CATALOG.pro_max_annual.monthlyCredits)
  })

  it('a second, different invoice for the same monthly subscription grants a second, separate batch', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id)

    await processStripeWebhookEvent(invoiceEvent(uniqueId('evt'), 'invoice.paid', { invoiceId: `in_${uniqueId('invoice')}`, subscriptionId, created: 1780000000 }), { db })
    await processStripeWebhookEvent(invoiceEvent(uniqueId('evt'), 'invoice.paid', { invoiceId: `in_${uniqueId('invoice')}`, subscriptionId, created: 1782592000 }), { db })

    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, organizationId))
    expect(grants).toHaveLength(2)
  })

  it('defers when the subscription has not been created yet (out-of-order delivery)', async () => {
    const result = await processStripeWebhookEvent(
      invoiceEvent(uniqueId('evt'), 'invoice.paid', { invoiceId: `in_${uniqueId('invoice')}`, subscriptionId: 'sub_never_seen', created: 1780000000 }),
      { db },
    )
    expect(result.outcome).toBe('deferred')
  })

  it('an out-of-order permutation (invoice.paid before customer.subscription.created) resolves once the subscription later appears', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const subscriptionId = `sub_${uniqueId('sub')}`
    const invoiceId = `in_${uniqueId('invoice')}`

    const deferred = await processStripeWebhookEvent(invoiceEvent(uniqueId('evt'), 'invoice.paid', { invoiceId, subscriptionId, created: 1780000000 }), { db })
    expect(deferred.outcome).toBe('deferred')

    await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.created', { subscriptionId, customerId: stripeCustomerId, status: 'active', created: 1780000000 }),
      { db },
    )

    const retried = await processStripeWebhookEvent(invoiceEvent(uniqueId('evt'), 'invoice.paid', { invoiceId, subscriptionId, created: 1780000000 }), { db })
    expect(retried.outcome).toBe('applied')

    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, organizationId))
    expect(grants).toHaveLength(1)
  })
})

describe('processStripeWebhookEvent — invoice.payment_failed', () => {
  it('sets a grace period marker on the subscription', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id)

    const result = await processStripeWebhookEvent(
      invoiceEvent(uniqueId('evt'), 'invoice.payment_failed', { invoiceId: `in_${uniqueId('invoice')}`, subscriptionId, created: 1780000000 }),
      { db },
    )

    expect(result.outcome).toBe('applied')
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(row.gracePeriodEndsAt).not.toBeNull()
  })

  it('does not move the grace period marker on a duplicate failure delivery', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id)

    await processStripeWebhookEvent(invoiceEvent(uniqueId('evt'), 'invoice.payment_failed', { invoiceId: `in_${uniqueId('invoice')}`, subscriptionId, created: 1780000000 }), { db })
    const [firstRow] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))

    await processStripeWebhookEvent(invoiceEvent(uniqueId('evt'), 'invoice.payment_failed', { invoiceId: `in_${uniqueId('invoice')}`, subscriptionId, created: 1790000000 }), { db })
    const [secondRow] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))

    expect(secondRow.gracePeriodEndsAt?.getTime()).toBe(firstRow.gracePeriodEndsAt?.getTime())
  })

  it('a recovering subscription.updated event clears an existing grace marker', async () => {
    const { organizationId } = await seedOrganization()
    const stripeCustomerId = await seedCustomer(organizationId)
    const customerRow = (await db.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)))[0]
    const subscriptionId = await seedSubscription(organizationId, customerRow.id, { stripeStatus: 'past_due', providerSyncedAt: new Date('2026-01-01T00:00:00Z') })

    await processStripeWebhookEvent(invoiceEvent(uniqueId('evt'), 'invoice.payment_failed', { invoiceId: `in_${uniqueId('invoice')}`, subscriptionId, created: 1780000000 }), { db })
    await processStripeWebhookEvent(
      subscriptionEvent(uniqueId('evt'), 'customer.subscription.updated', { subscriptionId, customerId: stripeCustomerId, status: 'active', created: Math.floor(new Date('2026-01-02T00:00:00Z').getTime() / 1000) }),
      { db },
    )

    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId))
    expect(row.gracePeriodEndsAt).toBeNull()
  })
})

describe('processStripeWebhookEvent — pack checkout (§8 task 1)', () => {
  it('grants exact pack credits on checkout.session.completed for a payment-mode session', async () => {
    const { organizationId, userId } = await seedOrganization()
    const sessionId = `cs_${uniqueId('session')}`
    await seedCheckoutAttempt(organizationId, userId, sessionId, { action: 'credits', catalogKey: 'starter_300' })

    const result = await processStripeWebhookEvent(
      checkoutSessionEvent(uniqueId('evt'), sessionId, 'checkout.session.completed', 1780000000, 'payment'),
      { db },
    )

    expect(result.outcome).toBe('applied')
    const [attempt] = await db.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.stripeCheckoutSessionId, sessionId))
    expect(attempt.status).toBe('complete')
    const grants = await db.select().from(billingCreditGrants).where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.source, 'pack')))
    expect(grants).toHaveLength(1)
    expect(grants[0].originalUnits).toBe(PACK_CATALOG.starter_300.credits)
    expect(grants[0].remainingUnits).toBe(PACK_CATALOG.starter_300.credits)
    expect(grants[0].stripePaymentReference).toBe(sessionId)
    const expectedExpiry = computeAnniversary(new Date(1780000000 * 1000), PACK_CATALOG.starter_300.expiryMonths)
    expect(grants[0].expiresAt.toISOString()).toBe(expectedExpiry.toISOString())
  })

  it('duplicate delivery of the same pack checkout session grants credits exactly once', async () => {
    const { organizationId, userId } = await seedOrganization()
    const sessionId = `cs_${uniqueId('session')}`
    await seedCheckoutAttempt(organizationId, userId, sessionId, { action: 'credits', catalogKey: 'scale_1000' })
    const event = checkoutSessionEvent(uniqueId('evt'), sessionId, 'checkout.session.completed', 1780000000, 'payment')

    await processStripeWebhookEvent(event, { db })
    const second = await processStripeWebhookEvent(event, { db })

    expect(second.outcome).toBe('applied')
    const grants = await db.select().from(billingCreditGrants).where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.source, 'pack')))
    expect(grants).toHaveLength(1)
  })

  it('a payment-mode session for a subscription checkout attempt (mismatched action) never grants pack credits', async () => {
    const { organizationId, userId } = await seedOrganization()
    const sessionId = `cs_${uniqueId('session')}`
    await seedCheckoutAttempt(organizationId, userId, sessionId, { action: 'subscription' })

    await processStripeWebhookEvent(checkoutSessionEvent(uniqueId('evt'), sessionId, 'checkout.session.completed', 1780000000, 'payment'), { db })

    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, organizationId))
    expect(grants).toHaveLength(0)
  })

  it('an expired pack checkout session never grants credits', async () => {
    const { organizationId, userId } = await seedOrganization()
    const sessionId = `cs_${uniqueId('session')}`
    await seedCheckoutAttempt(organizationId, userId, sessionId, { action: 'credits', catalogKey: 'starter_300' })

    await processStripeWebhookEvent(checkoutSessionEvent(uniqueId('evt'), sessionId, 'checkout.session.expired', 1780000000, 'payment'), { db })

    const [attempt] = await db.select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.stripeCheckoutSessionId, sessionId))
    expect(attempt.status).toBe('expired')
    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, organizationId))
    expect(grants).toHaveLength(0)
  })
})

describe('processStripeWebhookEvent — auto-recharge PaymentIntent (§8 task 2)', () => {
  it('grants pack credits and reactivates the rule on payment_intent.succeeded', async () => {
    const { organizationId, userId } = await seedOrganization()
    const paymentIntentId = `pi_${uniqueId('pi')}`
    await seedAutoRechargeRule(organizationId, userId, paymentIntentId)

    const result = await processStripeWebhookEvent(paymentIntentEvent(uniqueId('evt'), paymentIntentId, 'payment_intent.succeeded'), { db })

    expect(result.outcome).toBe('applied')
    const [rule] = await db.select().from(billingAutoRechargeRules).where(eq(billingAutoRechargeRules.organizationId, organizationId))
    expect(rule.state).toBe('active')
    expect(rule.pendingPaymentIntentId).toBeNull()
    const grants = await db.select().from(billingCreditGrants).where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.source, 'pack')))
    expect(grants).toHaveLength(1)
    expect(grants[0].originalUnits).toBe(PACK_CATALOG.starter_300.credits)
    expect(grants[0].stripePaymentReference).toBe(paymentIntentId)
  })

  it('duplicate delivery of the same succeeded PaymentIntent never grants credits twice', async () => {
    const { organizationId, userId } = await seedOrganization()
    const paymentIntentId = `pi_${uniqueId('pi')}`
    await seedAutoRechargeRule(organizationId, userId, paymentIntentId)
    const event = paymentIntentEvent(uniqueId('evt'), paymentIntentId, 'payment_intent.succeeded')

    const first = await processStripeWebhookEvent(event, { db })
    // The first delivery already cleared `pendingPaymentIntentId` on success, so a duplicate second
    // delivery of the SAME event can no longer resolve an organization for it — deferred, not
    // applied, but still safe: `resolveAutoRechargeTrigger`'s own pending-marker match means a
    // duplicate can never re-grant even if it WERE resolved. This is a known, documented tradeoff
    // (see webhook-handlers.ts's `handleAutoRechargePaymentIntentEvent` module comment), not a
    // correctness gap in the ledger.
    const second = await processStripeWebhookEvent(event, { db })

    expect(first.outcome).toBe('applied')
    expect(second.outcome).toBe('deferred')
    const grants = await db.select().from(billingCreditGrants).where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.source, 'pack')))
    expect(grants).toHaveLength(1)
  })

  it('pauses the rule as paused_needs_auth on payment_intent.requires_action, without granting credits', async () => {
    const { organizationId, userId } = await seedOrganization()
    const paymentIntentId = `pi_${uniqueId('pi')}`
    await seedAutoRechargeRule(organizationId, userId, paymentIntentId)

    await processStripeWebhookEvent(paymentIntentEvent(uniqueId('evt'), paymentIntentId, 'payment_intent.requires_action'), { db })

    const [rule] = await db.select().from(billingAutoRechargeRules).where(eq(billingAutoRechargeRules.organizationId, organizationId))
    expect(rule.state).toBe('paused_needs_auth')
    expect(rule.pendingPaymentIntentId).toBeNull()
    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, organizationId))
    expect(grants).toHaveLength(0)
  })

  it('pauses the rule as paused_failed on payment_intent.payment_failed, without granting credits', async () => {
    const { organizationId, userId } = await seedOrganization()
    const paymentIntentId = `pi_${uniqueId('pi')}`
    await seedAutoRechargeRule(organizationId, userId, paymentIntentId)

    await processStripeWebhookEvent(paymentIntentEvent(uniqueId('evt'), paymentIntentId, 'payment_intent.payment_failed'), { db })

    const [rule] = await db.select().from(billingAutoRechargeRules).where(eq(billingAutoRechargeRules.organizationId, organizationId))
    expect(rule.state).toBe('paused_failed')
    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, organizationId))
    expect(grants).toHaveLength(0)
  })

  it('defers a PaymentIntent event with no matching pending auto-recharge rule', async () => {
    const result = await processStripeWebhookEvent(paymentIntentEvent(uniqueId('evt'), 'pi_never_seen', 'payment_intent.succeeded'), { db })
    expect(result.outcome).toBe('deferred')
  })
})

describe('processStripeWebhookEvent — deferred and ignored families', () => {
  it.each([
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'payment_intent.requires_action',
    'charge.refunded',
    'refund.created',
    'refund.updated',
    'refund.failed',
    'charge.dispute.created',
    'charge.dispute.updated',
    'charge.dispute.closed',
    'charge.dispute.funds_reinstated',
  ] as const)('reports %s as deferred, not silently ignored', async (type) => {
    const event = { id: uniqueId('evt'), type, created: 1780000000, livemode: false, api_version: '2026-06-24.dahlia', data: { object: { id: 'x', object: 'x' } } } as unknown as Parameters<typeof processStripeWebhookEvent>[0]
    const result = await processStripeWebhookEvent(event, { db })
    expect(result.outcome).toBe('deferred')
  })

  it('reports a genuinely unrecognized event type as ignored', async () => {
    const event = { id: uniqueId('evt'), type: 'some.future.event.type', created: 1780000000, livemode: false, api_version: '2026-06-24.dahlia', data: { object: { id: 'x', object: 'x' } } } as unknown as Parameters<typeof processStripeWebhookEvent>[0]
    const result = await processStripeWebhookEvent(event, { db })
    expect(result.outcome).toBe('ignored')
  })
})
