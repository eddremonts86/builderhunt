/**
 * Real-network integration test for `RealBillingProvider` — hits the actual Stripe test-mode API
 * (never mocked), using the real Price IDs already provisioned in catalog.ts and Stripe's official
 * test PaymentMethod token (`pm_card_visa`) to drive off-session confirmation without any
 * Checkout UI/Elements. Skipped by default (see `shouldRun` below): it needs a real `sk_test_`
 * secret key AND an explicit opt-in, so `pnpm test`/CI never silently makes network calls to a
 * third party or requires Stripe credentials to pass.
 *
 * Run with:  RUN_STRIPE_INTEGRATION_TESTS=1 pnpm vitest run src/shared/lib/billing/real-provider.test.ts
 *
 * Does NOT reuse `provider-contract-suite.ts` unmodified — see real-provider.ts's header comment
 * for why `changeSubscription`'s "creates a subscription via changeSubscription on an arbitrary id"
 * assertion cannot run against a real Stripe adapter. This file exercises every method against a
 * subscription seeded through a genuine `stripe.subscriptions.create` call instead.
 */
import Stripe from 'stripe'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { RealBillingProvider } from '~/shared/lib/billing/real-provider'
import { BillingProviderError } from '~/shared/lib/billing/provider'
import { SUBSCRIPTION_CATALOG, PACK_CATALOG } from '~/shared/lib/billing/catalog'

// Read process.env directly, never the shared `env` singleton (src/shared/lib/env.ts) — that
// module is deliberately browser-stubbed whenever `window` is defined, which vitest's `happy-dom`
// test environment always does, so `env.STRIPE_SECRET_KEY` is unconditionally undefined in every
// test file regardless of what's actually in `.env`.
const rawSecretKey = process.env.STRIPE_SECRET_KEY
const rawApiVersion = process.env.STRIPE_API_VERSION
const hasRealTestKey = Boolean(rawSecretKey?.startsWith('sk_test_') && rawApiVersion)
const shouldRun = hasRealTestKey && process.env.RUN_STRIPE_INTEGRATION_TESTS === '1'

const proMonthlyPriceId = SUBSCRIPTION_CATALOG.pro_monthly.stripePriceId.test
const proMaxMonthlyPriceId = SUBSCRIPTION_CATALOG.pro_max_monthly.stripePriceId.test
const packPriceId = PACK_CATALOG.starter_300.stripePriceId.test

describe.skipIf(!shouldRun)('RealBillingProvider (real Stripe test-mode network calls)', () => {
  let stripe: Stripe
  let provider: RealBillingProvider
  const cleanupSubscriptionIds: string[] = []

  beforeAll(() => {
    if (!proMonthlyPriceId || !proMaxMonthlyPriceId || !packPriceId) {
      throw new Error('catalog.ts is missing a test Price ID this suite needs — run pnpm stripe:provision --write first')
    }
    stripe = new Stripe(rawSecretKey!, { apiVersion: rawApiVersion as Stripe.LatestApiVersion })
    provider = new RealBillingProvider(stripe)
  })

  afterAll(async () => {
    await Promise.all(cleanupSubscriptionIds.map((id) => stripe.subscriptions.cancel(id).catch(() => undefined)))
  })

  it('creates a customer, is idempotent, and round-trips through getCustomer', async () => {
    const key = `test-create-customer-${Date.now()}`
    // Stripe's idempotency guarantee only holds for a REPEATED call with the identical params —
    // reusing the key with different params is correctly rejected as a client error, not something
    // to route through BillingProviderError, so both calls here must match exactly.
    const input = { email: 'real-provider-test@example.com', metadata: { source: 'real-provider.test' }, idempotencyKey: key }
    const first = await provider.createCustomer(input)
    const second = await provider.createCustomer(input)
    expect(second.id).toBe(first.id)

    const fetched = await provider.getCustomer(first.id)
    expect(fetched?.id).toBe(first.id)
    expect(fetched?.email).toBe('real-provider-test@example.com')
    expect(await provider.getCustomer('cus_does_not_exist')).toBeNull()
  })

  it('creates a payment-mode checkout session, is idempotent, and round-trips its Checkout-time settings', async () => {
    const customer = await provider.createCustomer({ email: 'checkout-test@example.com', idempotencyKey: `checkout-customer-${Date.now()}` })
    const key = `checkout-session-${Date.now()}`
    const input = {
      customerId: customer.id,
      mode: 'payment' as const,
      priceId: packPriceId!,
      successUrl: 'https://app.test/success',
      cancelUrl: 'https://app.test/cancel',
      idempotencyKey: key,
      automaticTax: true,
      billingAddressCollection: 'required' as const,
      taxIdCollection: true,
      allowPromotionCodes: false,
      paymentMethodTypes: ['card'],
      // Required alongside automaticTax: Stripe Tax needs a location signal for the customer, and
      // this is what tells Checkout to save the address collected during checkout back onto the
      // Customer object rather than requiring one to already exist (mirrors checkout.ts's real call).
      customerUpdate: { address: 'auto' as const, name: 'auto' as const },
    }
    const first = await provider.createCheckoutSession(input)
    const second = await provider.createCheckoutSession(input)
    expect(second.id).toBe(first.id)
    expect(first.status).toBe('open')
    expect(first.url).toContain('checkout.stripe.com')
    expect(first.automaticTax).toBe(true)
    expect(first.billingAddressCollection).toBe('required')
    expect(first.taxIdCollection).toBe(true)
    expect(first.paymentMethodTypes).toEqual(['card'])

    const fetched = await provider.getCheckoutSession(first.id)
    expect(fetched?.id).toBe(first.id)
    expect(fetched?.priceId).toBe(packPriceId)
    expect(await provider.getCheckoutSession('cs_test_does_not_exist')).toBeNull()

    const refreshed = await provider.refreshObject('checkout_session', first.id)
    expect((refreshed as { id: string } | null)?.id).toBe(first.id)
  })

  it('creates a restricted Customer Portal session scoped to the given customer', async () => {
    const customer = await provider.createCustomer({ email: 'portal-test@example.com', idempotencyKey: `portal-customer-${Date.now()}` })
    const { url } = await provider.createPortalSession({ customerId: customer.id, returnUrl: 'https://app.test/billing' })
    expect(url).toContain('billing.stripe.com')

    // The restricted configuration must never allow plan switch/cancel — assert against the
    // ACTUAL Stripe configuration this adapter created/reused, not just trust our own code.
    const configurations = await stripe.billingPortal.configurations.list({ limit: 100 })
    const restricted = configurations.data.find((c) => c.metadata?.builderhunt_restricted_portal === 'true')
    expect(restricted?.features.subscription_update.enabled).toBe(false)
    expect(restricted?.features.subscription_cancel.enabled).toBe(false)
    expect(restricted?.features.payment_method_update.enabled).toBe(true)
  })

  it('supports the full subscription lifecycle: change price, preview, cancel at period end, cancel immediately', async () => {
    const customer = await provider.createCustomer({ email: 'subscription-test@example.com', idempotencyKey: `sub-customer-${Date.now()}` })
    // Seeded via a REAL stripe.subscriptions.create — never through changeSubscription on a
    // fabricated id, since real Stripe assigns subscription ids itself (see real-provider.ts's
    // header comment on this documented divergence from the fake provider / contract suite).
    const seeded = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: proMonthlyPriceId! }],
      payment_behavior: 'default_incomplete',
    })
    cleanupSubscriptionIds.push(seeded.id)

    const fetched = await provider.getSubscription(seeded.id)
    expect(fetched?.id).toBe(seeded.id)
    expect(fetched?.priceId).toBe(proMonthlyPriceId)

    const preview = await provider.previewSubscriptionChange({ subscriptionId: seeded.id, newPriceId: proMaxMonthlyPriceId! })
    expect(preview.currency).toBe('usd')
    expect(typeof preview.amountDue).toBe('number')

    const changeKey = `change-sub-${Date.now()}`
    const changedFirst = await provider.changeSubscription({ subscriptionId: seeded.id, newPriceId: proMaxMonthlyPriceId!, idempotencyKey: changeKey })
    expect(changedFirst.priceId).toBe(proMaxMonthlyPriceId)
    const changedSecond = await provider.changeSubscription({ subscriptionId: seeded.id, newPriceId: proMaxMonthlyPriceId!, idempotencyKey: changeKey })
    expect(changedSecond.id).toBe(changedFirst.id)

    const canceledAtPeriodEnd = await provider.cancelSubscription({ subscriptionId: seeded.id, atPeriodEnd: true })
    expect(canceledAtPeriodEnd.cancelAtPeriodEnd).toBe(true)
    expect(canceledAtPeriodEnd.status).not.toBe('canceled')

    const canceledImmediately = await provider.cancelSubscription({ subscriptionId: seeded.id, atPeriodEnd: false })
    expect(canceledImmediately.status).toBe('canceled')

    const refreshed = await provider.refreshObject('subscription', seeded.id)
    expect((refreshed as { status: string } | null)?.status).toBe('canceled')
  }, 20_000)

  it('confirms an off-session setup intent and payment intent against a real test card, then refunds it', async () => {
    const customer = await provider.createCustomer({ email: 'off-session-test@example.com', idempotencyKey: `off-session-customer-${Date.now()}` })
    const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: paymentMethod.id } })

    const setupIntent = await provider.createSetupIntent({ customerId: customer.id, idempotencyKey: `setup-${Date.now()}` })
    expect(setupIntent.status).toBe('succeeded')

    const paymentKey = `payment-${Date.now()}`
    const first = await provider.createPaymentIntent({ customerId: customer.id, amount: 500, currency: 'usd', idempotencyKey: paymentKey })
    expect(first.status).toBe('succeeded')
    const second = await provider.createPaymentIntent({ customerId: customer.id, amount: 500, currency: 'usd', idempotencyKey: paymentKey })
    expect(second.id).toBe(first.id)

    const refreshed = await provider.refreshObject('payment_intent', first.id)
    expect((refreshed as { id: string } | null)?.id).toBe(first.id)

    const refundKey = `refund-${Date.now()}`
    const refundFirst = await provider.createRefund({ paymentIntentId: first.id, idempotencyKey: refundKey })
    expect(refundFirst.status).toBe('succeeded')
    expect(refundFirst.amount).toBe(500)
    const refundSecond = await provider.createRefund({ paymentIntentId: first.id, idempotencyKey: refundKey })
    expect(refundSecond.id).toBe(refundFirst.id)
  }, 20_000)

  it('rejects an off-session charge with a BillingProviderError when the customer has no default payment method on file', async () => {
    // Stripe's decline-simulation PaymentMethod tokens (`pm_card_chargeDeclined`,
    // `pm_card_visa_chargeDeclined`) both fail at `paymentMethods.attach` time in this account/API
    // version — confirmed by direct probe, contradicting older Stripe docs describing a
    // declines-only-at-charge token. There is no reliable way in this test environment to get a
    // real `StripeCardError` all the way through to a confirmed off-session PaymentIntent, so this
    // exercises the adapter's OTHER real decline path instead: no default payment method on file.
    const customer = await provider.createCustomer({ email: 'decline-test@example.com', idempotencyKey: `decline-customer-${Date.now()}` })
    await expect(
      provider.createPaymentIntent({ customerId: customer.id, amount: 500, currency: 'usd', idempotencyKey: `decline-charge-${Date.now()}` }),
    ).rejects.toThrow(BillingProviderError)
  })

  it('lists customers, subscriptions, payment intents, and refunds for reconciliation without throwing', async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    for (const type of ['customers', 'subscriptions', 'payment_intents', 'refunds'] as const) {
      const results = await provider.listForReconciliation(type, { since })
      expect(Array.isArray(results)).toBe(true)
      for (const entry of results) {
        expect(entry).toHaveProperty('id')
      }
    }
  })
})
