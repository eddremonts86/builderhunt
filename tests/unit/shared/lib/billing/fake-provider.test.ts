import { beforeEach, describe, expect, it } from 'vitest'
import { FakeBillingProvider } from '~/shared/lib/billing/fake-provider'
import { runBillingProviderContractSuite } from '~/shared/lib/billing/provider-contract-suite'

describe('FakeBillingProvider — contract suite', () => {
  runBillingProviderContractSuite(() => new FakeBillingProvider())
})

describe('FakeBillingProvider — fake-only test helpers (no real-adapter equivalent)', () => {
  let provider: FakeBillingProvider

  beforeEach(() => {
    provider = new FakeBillingProvider()
  })

  it('settleCheckoutSession moves a delayed session to complete', async () => {
    const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'settle-1' })
    const session = await provider.createCheckoutSession({
      customerId: customer.id, mode: 'payment', priceId: 'price_pack', successUrl: 'https://app.test/s', cancelUrl: 'https://app.test/c',
      idempotencyKey: 'settle-checkout', scenario: 'delayed',
    })
    expect(session.status).toBe('open')
    const settled = provider.settleCheckoutSession(session.id)
    expect(settled.status).toBe('complete')
    expect((await provider.getCheckoutSession(session.id))?.status).toBe('complete')
  })

  it('settlePaymentIntent moves a delayed payment intent to succeeded', async () => {
    const customer = await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'settle-2' })
    const paymentIntent = await provider.createPaymentIntent({ customerId: customer.id, amount: 500, currency: 'usd', idempotencyKey: 'settle-pi', scenario: 'delayed' })
    expect(paymentIntent.status).toBe('processing')
    const settled = provider.settlePaymentIntent(paymentIntent.id)
    expect(settled.status).toBe('succeeded')
  })

  it('reset wipes all in-memory state', async () => {
    await provider.createCustomer({ email: 'a@example.com', idempotencyKey: 'reset-1' })
    expect(await provider.listForReconciliation('customers')).toHaveLength(1)
    provider.reset()
    expect(await provider.listForReconciliation('customers')).toHaveLength(0)
  })
})
