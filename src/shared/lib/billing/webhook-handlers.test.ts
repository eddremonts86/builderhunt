import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingCheckoutAttempts, billingCreditGrants, billingCustomers, billingSubscriptions, organizations } from '../db/schema'
import { SUBSCRIPTION_CATALOG } from './catalog'
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

async function seedCheckoutAttempt(organizationId: string, userId: string, stripeCheckoutSessionId: string): Promise<string> {
  const id = uniqueId('attempt')
  await db.insert(billingCheckoutAttempts).values({
    id, organizationId, actorUserId: userId, livemode: false, action: 'subscription',
    catalogKey: 'pro_monthly', idempotencyKey: uniqueId('idem'), consentVersions: { terms: 'v1.0', privacy: 'v1.0' },
    stripeCheckoutSessionId, expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return id
}

async function seedSubscription(
  organizationId: string,
  customerId: string,
  overrides: Partial<{ stripeSubscriptionId: string; stripeStatus: string; providerSyncedAt: Date; catalogKey: string; tier: string; interval: string }> = {},
): Promise<string> {
  const stripeSubscriptionId = overrides.stripeSubscriptionId ?? `sub_${uniqueId('sub')}`
  await db.insert(billingSubscriptions).values({
    id: uniqueId('subrow'), organizationId, customerId, livemode: false,
    catalogKey: overrides.catalogKey ?? 'pro_monthly', tier: overrides.tier ?? 'pro', interval: overrides.interval ?? 'monthly', catalogVersion: 1,
    stripeSubscriptionId, stripeStatus: overrides.stripeStatus ?? 'active',
    providerSyncedAt: overrides.providerSyncedAt ?? new Date('2026-01-01T00:00:00Z'),
  })
  return stripeSubscriptionId
}

function checkoutSessionEvent(id: string, sessionId: string, type: 'checkout.session.completed' | 'checkout.session.expired', created = 1780000000) {
  return {
    id, type, created, livemode: false, api_version: '2026-06-24.dahlia',
    data: { object: { id: sessionId, object: 'checkout.session', mode: 'subscription' } },
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
  })

  it('applies a newer status update on an existing subscription', async () => {
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
