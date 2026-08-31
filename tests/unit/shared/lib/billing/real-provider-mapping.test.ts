/**
 * What `RealBillingProvider` does with a Checkout Session value it does not recognise.
 *
 * Its sibling `real-provider.test.ts` drives the real Stripe test-mode API and is skipped unless a
 * key and an opt-in are both present, so nothing here has ever been asserted on a normal run. These
 * cases need no network at all: the provider takes its Stripe client by constructor injection, and
 * the whole question is what the mapping does with a value on the way back.
 *
 * The question is not hypothetical. `Stripe.Checkout.Session.Status` carries an `OtherString` arm
 * for statuses added after the pinned SDK version — 22.6.0 added that arm to this very union — and
 * the domain type is `'open' | 'complete' | 'expired'`. Without a translation, a status Stripe
 * introduces tomorrow arrives in a field three branches read as if it were one of those three.
 */
import { describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { RealBillingProvider } from '~/shared/lib/billing/real-provider'

/** The smallest Session the mapping reads, with everything else left to its null branches. */
function session(status: unknown): Stripe.Checkout.Session {
  return {
    id: 'cs_test_mapping',
    created: 1_756_000_000,
    customer: 'cus_test_mapping',
    mode: 'subscription',
    status,
    url: 'https://checkout.stripe.test/c/cs_test_mapping',
    metadata: {},
    automatic_tax: { enabled: false },
    billing_address_collection: 'auto',
    tax_id_collection: { enabled: false },
    allow_promotion_codes: false,
    payment_method_types: ['card'],
    line_items: { data: [{ price: { id: 'price_test_mapping' } }] },
  } as unknown as Stripe.Checkout.Session
}

function providerReturning(value: Stripe.Checkout.Session): RealBillingProvider {
  return new RealBillingProvider({
    checkout: { sessions: { retrieve: async () => value } },
  } as unknown as Stripe)
}

describe('RealBillingProvider checkout session status', () => {
  it.each([
    ['complete', 'complete'],
    ['expired', 'expired'],
    ['open', 'open'],
  ])('passes %s through as %s', async (given, expected) => {
    const result = await providerReturning(session(given)).getCheckoutSession('cs_test_mapping')
    expect(result?.status).toBe(expected)
  })

  it('reads a status this SDK version does not know as open, not as itself', async () => {
    // `open` rather than a throw because this is a read path, and `open` is the arm that grants
    // nothing: `checkout.ts` asks only whether a session is `expired`, so an unrecognised status
    // reads as still in progress. Being wrong in that direction costs a wait, not an entitlement.
    const result = await providerReturning(session('requires_action')).getCheckoutSession('cs_test_mapping')
    expect(result?.status).toBe('open')
  })

  it('reads a missing status as open', async () => {
    const result = await providerReturning(session(null)).getCheckoutSession('cs_test_mapping')
    expect(result?.status).toBe('open')
  })
})
