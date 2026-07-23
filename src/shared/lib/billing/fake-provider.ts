/**
 * Deterministic, in-memory implementation of `BillingProvider` — no network
 * access, safe for unit/API tests. Every call site that will eventually use
 * the real Stripe-backed adapter (built once real credentials exist, in a
 * later phase) is written against `BillingProvider` and exercised here
 * first; `fake-provider.test.ts` is designed to run unchanged against that
 * future adapter too (see its top-of-file comment).
 *
 * Scenario injection: pass `scenario` on a create call to force a specific
 * outcome deterministically — no real timers, no randomness.
 * - `success` (default): completes immediately in a terminal success state.
 * - `sca_required`: checkout/payment intent comes back requiring further
 *   customer action (simulates 3DS), never silently succeeds.
 * - `decline`: throws `BillingProviderError` immediately (simulates a card
 *   decline) — nothing is created.
 * - `timeout`: throws `BillingProviderError` immediately with a
 *   timeout-shaped message — never actually waits with a real timer.
 * - `delayed`: creates the object in a non-terminal state (`open`/
 *   `processing`); call `settleCheckoutSession`/`settlePaymentIntent` to
 *   move it to its terminal state, simulating an async webhook arriving
 *   later. Never auto-settles.
 * - `out_of_order`: tags the created object so `listForReconciliation`
 *   returns that object type's list in reverse-of-creation order.
 * - `duplicate` is not a create-time scenario — it's exercised structurally
 *   by calling any create method twice with the *same* `idempotencyKey` and
 *   asserting the second call returns the identical result without
 *   creating a second object.
 */
import { randomUUID } from 'node:crypto'
import type {
  BillingCheckoutSession,
  BillingCustomer,
  BillingPaymentIntent,
  BillingProvider,
  BillingRefund,
  BillingScenario,
  BillingSubscription,
  CancelSubscriptionInput,
  ChangeSubscriptionInput,
  CreateCheckoutSessionInput,
  CreateCustomerInput,
  CreatePaymentIntentInput,
  CreatePortalSessionInput,
  CreateRefundInput,
  CreateSetupIntentInput,
  PreviewSubscriptionChangeInput,
  ReconciliationObjectType,
  RefreshableObjectType,
  SetupIntentResult,
  SubscriptionPreview,
} from './provider'
import { BillingProviderError } from './provider'

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function assertNotDeclineOrTimeout(scenario: BillingScenario | undefined): void {
  if (scenario === 'decline') {
    throw new BillingProviderError('Your card was declined.', 'decline')
  }
  if (scenario === 'timeout') {
    throw new BillingProviderError('The provider did not respond in time.', 'timeout')
  }
}

export class FakeBillingProvider implements BillingProvider {
  private readonly customers = new Map<string, BillingCustomer>()
  private readonly checkoutSessions = new Map<string, BillingCheckoutSession>()
  private readonly subscriptions = new Map<string, BillingSubscription>()
  private readonly paymentIntents = new Map<string, BillingPaymentIntent>()
  private readonly refunds = new Map<string, BillingRefund>()
  /** `${operation}:${idempotencyKey}` -> the id of the object that call created. */
  private readonly idempotency = new Map<string, string>()
  private readonly outOfOrderTags = new Set<string>()

  async createCustomer(input: CreateCustomerInput): Promise<BillingCustomer> {
    const dedupeKey = `createCustomer:${input.idempotencyKey}`
    const existingId = this.idempotency.get(dedupeKey)
    if (existingId) return this.customers.get(existingId)!

    const now = new Date().toISOString()
    const customer: BillingCustomer = { id: id('cus'), email: input.email, metadata: input.metadata ?? {}, createdAt: now }
    this.customers.set(customer.id, customer)
    this.idempotency.set(dedupeKey, customer.id)
    return customer
  }

  async getCustomer(customerId: string): Promise<BillingCustomer | null> {
    return this.customers.get(customerId) ?? null
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<BillingCheckoutSession> {
    const dedupeKey = `createCheckoutSession:${input.idempotencyKey}`
    const existingId = this.idempotency.get(dedupeKey)
    if (existingId) return this.checkoutSessions.get(existingId)!

    assertNotDeclineOrTimeout(input.scenario)
    const now = new Date().toISOString()
    const sessionId = id('cs')
    const status = input.scenario === 'delayed' || input.scenario === 'sca_required' ? 'open' : 'complete'
    const session: BillingCheckoutSession = {
      id: sessionId,
      customerId: input.customerId,
      mode: input.mode,
      status,
      url: `https://checkout.stripe.test/${sessionId}`,
      priceId: input.priceId,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      automaticTax: input.automaticTax ?? false,
      billingAddressCollection: input.billingAddressCollection ?? 'auto',
      taxIdCollection: input.taxIdCollection ?? false,
      allowPromotionCodes: input.allowPromotionCodes ?? false,
      paymentMethodTypes: input.paymentMethodTypes ?? [],
    }
    this.checkoutSessions.set(sessionId, session)
    this.idempotency.set(dedupeKey, sessionId)
    if (input.scenario === 'out_of_order') this.outOfOrderTags.add('checkout_sessions')
    return session
  }

  async getCheckoutSession(checkoutSessionId: string): Promise<BillingCheckoutSession | null> {
    return this.checkoutSessions.get(checkoutSessionId) ?? null
  }

  /** Fake-only: moves a `delayed`/`sca_required` checkout session to `complete`, simulating a webhook confirming payment. */
  settleCheckoutSession(checkoutSessionId: string): BillingCheckoutSession {
    const session = this.checkoutSessions.get(checkoutSessionId)
    if (!session) throw new Error(`Unknown checkout session: ${checkoutSessionId}`)
    const settled: BillingCheckoutSession = { ...session, status: 'complete', updatedAt: new Date().toISOString() }
    this.checkoutSessions.set(checkoutSessionId, settled)
    return settled
  }

  async createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }> {
    return { url: `https://billing.stripe.test/portal/${input.customerId}?return=${encodeURIComponent(input.returnUrl)}` }
  }

  async previewSubscriptionChange(input: PreviewSubscriptionChangeInput): Promise<SubscriptionPreview> {
    const subscription = this.subscriptions.get(input.subscriptionId)
    if (!subscription) throw new Error(`Unknown subscription: ${input.subscriptionId}`)
    const now = new Date()
    return {
      amountDue: 0,
      currency: 'usd',
      prorationDate: now.toISOString(),
      nextPaymentDate: subscription.currentPeriodEnd,
    }
  }

  async changeSubscription(input: ChangeSubscriptionInput): Promise<BillingSubscription> {
    const dedupeKey = `changeSubscription:${input.idempotencyKey}`
    const existingId = this.idempotency.get(dedupeKey)
    if (existingId) return this.subscriptions.get(existingId)!

    const existing = this.subscriptions.get(input.subscriptionId)
    const now = new Date()
    const periodEnd = new Date(now)
    periodEnd.setMonth(periodEnd.getMonth() + 1)
    const subscription: BillingSubscription = existing
      ? { ...existing, priceId: input.newPriceId, updatedAt: now.toISOString() }
      : {
          id: input.subscriptionId,
          customerId: id('cus'),
          status: 'active',
          priceId: input.newPriceId,
          currentPeriodEnd: periodEnd.toISOString(),
          cancelAtPeriodEnd: false,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
    this.subscriptions.set(subscription.id, subscription)
    this.idempotency.set(dedupeKey, subscription.id)
    return subscription
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<BillingSubscription> {
    const subscription = this.subscriptions.get(input.subscriptionId)
    if (!subscription) throw new Error(`Unknown subscription: ${input.subscriptionId}`)
    const updated: BillingSubscription = {
      ...subscription,
      status: input.atPeriodEnd ? subscription.status : 'canceled',
      cancelAtPeriodEnd: input.atPeriodEnd,
      updatedAt: new Date().toISOString(),
    }
    this.subscriptions.set(input.subscriptionId, updated)
    return updated
  }

  async getSubscription(subscriptionId: string): Promise<BillingSubscription | null> {
    return this.subscriptions.get(subscriptionId) ?? null
  }

  async createSetupIntent(input: CreateSetupIntentInput): Promise<SetupIntentResult> {
    const dedupeKey = `createSetupIntent:${input.idempotencyKey}`
    const existingId = this.idempotency.get(dedupeKey)
    const setupIntentId = existingId ?? id('seti')
    if (!existingId) this.idempotency.set(dedupeKey, setupIntentId)
    return { id: setupIntentId, clientSecret: `${setupIntentId}_secret`, status: 'succeeded' }
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<BillingPaymentIntent> {
    const dedupeKey = `createPaymentIntent:${input.idempotencyKey}`
    const existingId = this.idempotency.get(dedupeKey)
    if (existingId) return this.paymentIntents.get(existingId)!

    assertNotDeclineOrTimeout(input.scenario)
    const now = new Date().toISOString()
    const status =
      input.scenario === 'delayed' ? 'processing'
        : input.scenario === 'sca_required' ? 'requires_action'
          : 'succeeded'
    const paymentIntent: BillingPaymentIntent = {
      id: id('pi'),
      customerId: input.customerId,
      status,
      amount: input.amount,
      currency: input.currency,
      createdAt: now,
      updatedAt: now,
    }
    this.paymentIntents.set(paymentIntent.id, paymentIntent)
    this.idempotency.set(dedupeKey, paymentIntent.id)
    if (input.scenario === 'out_of_order') this.outOfOrderTags.add('payment_intents')
    return paymentIntent
  }

  /** Fake-only: moves a `delayed`/`sca_required` payment intent to `succeeded`. */
  settlePaymentIntent(paymentIntentId: string): BillingPaymentIntent {
    const paymentIntent = this.paymentIntents.get(paymentIntentId)
    if (!paymentIntent) throw new Error(`Unknown payment intent: ${paymentIntentId}`)
    const settled: BillingPaymentIntent = { ...paymentIntent, status: 'succeeded', updatedAt: new Date().toISOString() }
    this.paymentIntents.set(paymentIntentId, settled)
    return settled
  }

  async createRefund(input: CreateRefundInput): Promise<BillingRefund> {
    const dedupeKey = `createRefund:${input.idempotencyKey}`
    const existingId = this.idempotency.get(dedupeKey)
    if (existingId) return this.refunds.get(existingId)!

    const paymentIntent = this.paymentIntents.get(input.paymentIntentId)
    if (!paymentIntent) throw new Error(`Unknown payment intent: ${input.paymentIntentId}`)
    const now = new Date().toISOString()
    const refund: BillingRefund = {
      id: id('re'),
      paymentIntentId: input.paymentIntentId,
      amount: input.amount ?? paymentIntent.amount,
      status: 'succeeded',
      createdAt: now,
      updatedAt: now,
    }
    this.refunds.set(refund.id, refund)
    this.idempotency.set(dedupeKey, refund.id)
    return refund
  }

  async refreshObject(type: RefreshableObjectType, refreshId: string): Promise<unknown> {
    switch (type) {
      case 'customer': return this.getCustomer(refreshId)
      case 'subscription': return this.getSubscription(refreshId)
      case 'checkout_session': return this.getCheckoutSession(refreshId)
      case 'payment_intent': return this.paymentIntents.get(refreshId) ?? null
    }
  }

  async listForReconciliation(type: ReconciliationObjectType): Promise<unknown[]> {
    const source: Map<string, unknown> = {
      customers: this.customers,
      subscriptions: this.subscriptions,
      payment_intents: this.paymentIntents,
      refunds: this.refunds,
    }[type]
    const values = Array.from(source.values())
    // "checkout_sessions"/"payment_intents" out-of-order tagging only applies
    // to the object type it was set for; reversing is a deterministic stand-in
    // for real out-of-order delivery, never randomized.
    const tagKey = type === 'payment_intents' ? 'payment_intents' : type === 'subscriptions' ? 'checkout_sessions' : null
    if (tagKey && this.outOfOrderTags.has(tagKey)) return values.slice().reverse()
    return values
  }

  /** Test-only: wipes all in-memory state between test cases. */
  reset(): void {
    this.customers.clear()
    this.checkoutSessions.clear()
    this.subscriptions.clear()
    this.paymentIntents.clear()
    this.refunds.clear()
    this.idempotency.clear()
    this.outOfOrderTags.clear()
  }
}
