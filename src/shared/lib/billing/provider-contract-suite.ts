/**
 * Reusable `BillingProvider` conformance suite. `fake-provider.test.ts` runs
 * this against `FakeBillingProvider`; the real Stripe-backed adapter (built
 * once real sandbox credentials exist, per docs/operations/stripe-launch-register.md)
 * must import and run this SAME function against itself, unmodified — that's
 * the task's verify criterion ("contract suite passes identically against
 * fake and Stripe sandbox adapter for supported operations"). Anything that
 * can't run against a real adapter without a live network call (this suite
 * has none) doesn't belong in here — it belongs in that adapter's own tests.
 */
import { describe, expect, it } from 'vitest'
import type { BillingProvider } from './provider'
import { BillingProviderError } from './provider'

export function runBillingProviderContractSuite(createProvider: () => BillingProvider): void {
  describe('createCustomer', () => {
    it('creates a customer with the given email and metadata', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'owner@example.com', metadata: { organizationId: 'org-a' }, idempotencyKey: 'k1' })
      expect(customer.email).toBe('owner@example.com')
      expect(customer.metadata).toEqual({ organizationId: 'org-a' })
    })

    it('is idempotent — the same key returns the same customer, never a second one', async () => {
      const provider = createProvider()
      const first = await provider.createCustomer({ email: 'owner@example.com', idempotencyKey: 'same-key' })
      const second = await provider.createCustomer({ email: 'owner@example.com', idempotencyKey: 'same-key' })
      expect(second.id).toBe(first.id)
    })

    it('round-trips through getCustomer', async () => {
      const provider = createProvider()
      const created = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k2' })
      expect(await provider.getCustomer(created.id)).toEqual(created)
      expect(await provider.getCustomer('nonexistent')).toBeNull()
    })
  })

  describe('createCheckoutSession', () => {
    it('completes immediately on the success scenario (default)', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k3' })
      const session = await provider.createCheckoutSession({
        customerId: customer.id, mode: 'subscription', priceId: 'price_pro_monthly',
        successUrl: 'https://app.test/success', cancelUrl: 'https://app.test/cancel', idempotencyKey: 'checkout-1',
      })
      expect(session.status).toBe('complete')
    })

    it('is idempotent — the same key returns the same session', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k4' })
      const input = { customerId: customer.id, mode: 'subscription' as const, priceId: 'price_pro_monthly', successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c', idempotencyKey: 'checkout-dup' }
      const first = await provider.createCheckoutSession(input)
      const second = await provider.createCheckoutSession(input)
      expect(second.id).toBe(first.id)
    })

    it('requires further action on the sca_required scenario, never silently completing', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k5' })
      const session = await provider.createCheckoutSession({
        customerId: customer.id, mode: 'subscription', priceId: 'price_pro_monthly',
        successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c', idempotencyKey: 'checkout-sca', scenario: 'sca_required',
      })
      expect(session.status).toBe('open')
    })

    it('rejects immediately on the decline scenario — nothing is created', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k6' })
      await expect(provider.createCheckoutSession({
        customerId: customer.id, mode: 'payment', priceId: 'price_pack', successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c',
        idempotencyKey: 'checkout-decline', scenario: 'decline',
      })).rejects.toThrow(BillingProviderError)
    })

    it('rejects immediately on the timeout scenario', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k7' })
      await expect(provider.createCheckoutSession({
        customerId: customer.id, mode: 'payment', priceId: 'price_pack', successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c',
        idempotencyKey: 'checkout-timeout', scenario: 'timeout',
      })).rejects.toThrow(BillingProviderError)
    })

    it('stays open on the delayed scenario until explicitly settled', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k8' })
      const session = await provider.createCheckoutSession({
        customerId: customer.id, mode: 'payment', priceId: 'price_pack', successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c',
        idempotencyKey: 'checkout-delayed', scenario: 'delayed',
      })
      expect(session.status).toBe('open')
      expect((await provider.getCheckoutSession(session.id))?.status).toBe('open')
    })
  })

  describe('createPortalSession', () => {
    it('returns a URL scoped to the given customer', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k9' })
      const { url } = await provider.createPortalSession({ customerId: customer.id, returnUrl: 'https://app.test/billing' })
      expect(url).toContain(customer.id)
    })
  })

  describe('subscription lifecycle', () => {
    it('creates a subscription via changeSubscription and previews a change', async () => {
      const provider = createProvider()
      const subscription = await provider.changeSubscription({ subscriptionId: 'sub_1', newPriceId: 'price_pro_monthly', idempotencyKey: 'sub-create' })
      expect(subscription.priceId).toBe('price_pro_monthly')
      expect(subscription.status).toBe('active')

      const preview = await provider.previewSubscriptionChange({ subscriptionId: subscription.id, newPriceId: 'price_pro_max_monthly' })
      expect(preview.currency).toBe('usd')
    })

    it('is idempotent — the same change key never double-applies', async () => {
      const provider = createProvider()
      const first = await provider.changeSubscription({ subscriptionId: 'sub_2', newPriceId: 'price_pro_monthly', idempotencyKey: 'change-dup' })
      const second = await provider.changeSubscription({ subscriptionId: 'sub_2', newPriceId: 'price_team_monthly', idempotencyKey: 'change-dup' })
      expect(second.priceId).toBe(first.priceId)
    })

    it('cancels at period end without immediately terminating access', async () => {
      const provider = createProvider()
      await provider.changeSubscription({ subscriptionId: 'sub_3', newPriceId: 'price_pro_monthly', idempotencyKey: 'sub-3-create' })
      const cancelled = await provider.cancelSubscription({ subscriptionId: 'sub_3', atPeriodEnd: true })
      expect(cancelled.cancelAtPeriodEnd).toBe(true)
      expect(cancelled.status).toBe('active')
    })

    it('cancels immediately when atPeriodEnd is false', async () => {
      const provider = createProvider()
      await provider.changeSubscription({ subscriptionId: 'sub_4', newPriceId: 'price_pro_monthly', idempotencyKey: 'sub-4-create' })
      const cancelled = await provider.cancelSubscription({ subscriptionId: 'sub_4', atPeriodEnd: false })
      expect(cancelled.status).toBe('canceled')
    })
  })

  describe('setup intents', () => {
    it('succeeds immediately and is idempotent', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k10' })
      const first = await provider.createSetupIntent({ customerId: customer.id, idempotencyKey: 'seti-1' })
      const second = await provider.createSetupIntent({ customerId: customer.id, idempotencyKey: 'seti-1' })
      expect(second.id).toBe(first.id)
      expect(first.status).toBe('succeeded')
    })
  })

  describe('payment intents', () => {
    it('succeeds on the success scenario (default)', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k11' })
      const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: 'pi-1' })
      expect(paymentIntent.status).toBe('succeeded')
    })

    it('requires action on the sca_required scenario', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k12' })
      const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: 'pi-sca', scenario: 'sca_required' })
      expect(paymentIntent.status).toBe('requires_action')
    })

    it('rejects on the decline scenario — no payment intent is created', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k13' })
      await expect(provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: 'pi-decline', scenario: 'decline' }))
        .rejects.toThrow(BillingProviderError)
    })

    it('is idempotent — the same key never double-charges', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k14' })
      const input = { customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: 'pi-dup' }
      const first = await provider.createPaymentIntent(input)
      const second = await provider.createPaymentIntent(input)
      expect(second.id).toBe(first.id)
    })

    it('stays processing on the delayed scenario until explicitly settled', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k15' })
      const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: 'pi-delayed', scenario: 'delayed' })
      expect(paymentIntent.status).toBe('processing')
    })
  })

  describe('refunds', () => {
    it('refunds a succeeded payment intent and is idempotent', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k16' })
      const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: 'pi-refund' })
      const first = await provider.createRefund({ paymentIntentId: paymentIntent.id, idempotencyKey: 'refund-1' })
      const second = await provider.createRefund({ paymentIntentId: paymentIntent.id, idempotencyKey: 'refund-1' })
      expect(second.id).toBe(first.id)
      expect(first.status).toBe('succeeded')
      expect(first.amount).toBe(1500)
    })

    it('supports a partial refund amount', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k17' })
      const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 1500, currency: 'usd', idempotencyKey: 'pi-partial' })
      const refund = await provider.createRefund({ paymentIntentId: paymentIntent.id, amount: 500, idempotencyKey: 'refund-partial' })
      expect(refund.amount).toBe(500)
    })
  })

  describe('refreshObject', () => {
    it('re-fetches the current state of a customer, subscription, checkout session, and payment intent', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k18' })
      expect(await provider.refreshObject('customer', customer.id)).toEqual(customer)

      const subscription = await provider.changeSubscription({ subscriptionId: 'sub_refresh', newPriceId: 'price_pro_monthly', idempotencyKey: 'sub-refresh' })
      expect(await provider.refreshObject('subscription', subscription.id)).toEqual(subscription)

      const session = await provider.createCheckoutSession({
        customerId: customer.id, mode: 'subscription', priceId: 'price_pro_monthly', successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c', idempotencyKey: 'checkout-refresh',
      })
      expect(await provider.refreshObject('checkout_session', session.id)).toEqual(session)

      const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 100, currency: 'usd', idempotencyKey: 'pi-refresh' })
      expect(await provider.refreshObject('payment_intent', paymentIntent.id)).toEqual(paymentIntent)
    })
  })

  describe('listForReconciliation', () => {
    it('lists every created customer', async () => {
      const provider = createProvider()
      await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k19' })
      await provider.createCustomer({ email: 'b@example.com', idempotencyKey: 'k20' })
      const customers = await provider.listForReconciliation('customers')
      expect(customers).toHaveLength(2)
    })

    it('never assumes list position matches creation order — reconciliation must key off object identity', async () => {
      const provider = createProvider()
      const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'k21' })
      await provider.createPaymentIntent({ customerId: customer.id, amount: 100, currency: 'usd', idempotencyKey: 'pi-order-1' })
      await provider.createPaymentIntent({ customerId: customer.id, amount: 200, currency: 'usd', idempotencyKey: 'pi-order-2', scenario: 'out_of_order' })
      const paymentIntents = await provider.listForReconciliation('payment_intents')
      expect(paymentIntents).toHaveLength(2)
      // Whatever the actual order, every entry must still be individually identifiable and complete.
      for (const entry of paymentIntents) {
        expect(entry).toHaveProperty('id')
        expect(entry).toHaveProperty('status')
      }
    })
  })
}
