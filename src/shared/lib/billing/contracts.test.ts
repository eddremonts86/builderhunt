import { describe, expect, it } from 'vitest'
import {
  toBillingCheckoutAttemptSummaryDto,
  toBillingCreditGrantSummaryDto,
  toBillingCreditReservationSummaryDto,
  toBillingCustomerSummaryDto,
  toBillingRefundSummaryDto,
  toBillingSubscriptionSummaryDto,
  toBillingTermsAcceptanceSummaryDto,
} from './contracts'

describe('billing contracts — DTO mapping', () => {
  it('maps a null customer to null', () => {
    expect(toBillingCustomerSummaryDto(null)).toBeNull()
  })

  it('never leaks the raw Stripe customer id — only a boolean and livemode flag', () => {
    const dto = toBillingCustomerSummaryDto({
      id: 'cust-1',
      organizationId: 'org-1',
      livemode: false,
      stripeCustomerId: 'cus_live_secret_reference',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    } as never)
    expect(dto).toEqual({ hasStripeCustomer: true, livemode: false })
    expect(dto).not.toHaveProperty('stripeCustomerId')
    expect(dto).not.toHaveProperty('id')
    expect(dto).not.toHaveProperty('organizationId')
  })

  it('maps a null subscription to null', () => {
    expect(toBillingSubscriptionSummaryDto(null)).toBeNull()
  })

  it('never leaks the raw Stripe subscription id, customer id, or organization id from a subscription row', () => {
    const dto = toBillingSubscriptionSummaryDto({
      id: 'sub-1',
      organizationId: 'org-1',
      customerId: 'cust-1',
      stripeSubscriptionId: 'sub_live_secret_reference',
      tier: 'pro',
      interval: 'monthly',
      stripeStatus: 'active',
      currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
    } as never)
    expect(dto).toEqual({
      tier: 'pro',
      interval: 'monthly',
      status: 'active',
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    })
    expect(dto).not.toHaveProperty('stripeSubscriptionId')
    expect(dto).not.toHaveProperty('customerId')
    expect(dto).not.toHaveProperty('organizationId')
  })

  it('maps a null currentPeriodEnd to null rather than throwing', () => {
    const dto = toBillingSubscriptionSummaryDto({
      tier: 'team', interval: 'annual', stripeStatus: 'trialing', currentPeriodEnd: null, cancelAtPeriodEnd: true,
    } as never)
    expect(dto?.currentPeriodEnd).toBeNull()
  })

  it('strips actor/organization ids and the Stripe Checkout Session id from a checkout attempt row — including a simulated raw-payload field', () => {
    const dto = toBillingCheckoutAttemptSummaryDto({
      id: 'attempt-1',
      organizationId: 'org-1',
      actorUserId: 'user-1',
      action: 'subscription',
      catalogKey: 'pro_monthly',
      status: 'open',
      stripeCheckoutSessionId: 'cs_live_secret',
      idempotencyKey: 'idem-1',
      expiresAt: new Date('2026-07-24T00:00:00Z'),
      // Simulated malicious/unexpected extra fields a compromised or buggy caller might attach —
      // proves the mapper only ever reads the fields it declares, never spreads the input.
      rawStripePayload: { card: { last4: '4242' }, bank_account: { number: '000123456789' } },
      cardLast4: '4242',
      bankAccountNumber: '000123456789',
    } as never)
    expect(dto).toEqual({
      action: 'subscription',
      catalogKey: 'pro_monthly',
      status: 'open',
      expiresAt: '2026-07-24T00:00:00.000Z',
    })
    expect(dto).not.toHaveProperty('rawStripePayload')
    expect(dto).not.toHaveProperty('cardLast4')
    expect(dto).not.toHaveProperty('bankAccountNumber')
    expect(dto).not.toHaveProperty('stripeCheckoutSessionId')
    expect(dto).not.toHaveProperty('organizationId')
    expect(dto).not.toHaveProperty('actorUserId')
  })

  it('maps a terms acceptance row without leaking the actor/organization id or reference id', () => {
    const dto = toBillingTermsAcceptanceSummaryDto({
      id: 'accept-1',
      organizationId: 'org-1',
      actorUserId: 'user-1',
      termsVersion: 'v2',
      privacyVersion: 'v3',
      commercialAction: 'checkout_subscription',
      referenceId: 'attempt-1',
      acceptedAt: new Date('2026-07-01T00:00:00Z'),
    } as never)
    expect(dto).toEqual({
      termsVersion: 'v2',
      privacyVersion: 'v3',
      commercialAction: 'checkout_subscription',
      acceptedAt: '2026-07-01T00:00:00.000Z',
    })
    expect(dto).not.toHaveProperty('referenceId')
    expect(dto).not.toHaveProperty('organizationId')
  })

  it('maps a credit grant row without leaking the Stripe payment reference or organization id', () => {
    const dto = toBillingCreditGrantSummaryDto({
      id: 'grant-1',
      organizationId: 'org-1',
      source: 'subscription_monthly',
      stripePaymentReference: 'in_live_secret_invoice',
      remainingUnits: 90,
      originalUnits: 140,
      expiresAt: new Date('2026-08-01T00:00:00Z'),
    } as never)
    expect(dto).toEqual({ source: 'subscription_monthly', remainingUnits: 90, expiresAt: '2026-08-01T00:00:00.000Z' })
    expect(dto).not.toHaveProperty('stripePaymentReference')
    expect(dto).not.toHaveProperty('originalUnits')
  })

  it('maps a credit reservation row without leaking the idempotency key or organization id', () => {
    const dto = toBillingCreditReservationSummaryDto({
      id: 'reservation-1',
      organizationId: 'org-1',
      operation: 'ai_sourcing_sprint',
      idempotencyKey: 'idem-reservation-1',
      maximumUnits: 25,
      state: 'reserved',
    } as never)
    expect(dto).toEqual({ operation: 'ai_sourcing_sprint', maximumUnits: 25, state: 'reserved' })
    expect(dto).not.toHaveProperty('idempotencyKey')
    expect(dto).not.toHaveProperty('organizationId')
  })

  it('maps a refund row without leaking the Stripe refund id, requester id, or organization id', () => {
    const dto = toBillingRefundSummaryDto({
      id: 'refund-1',
      organizationId: 'org-1',
      requestedByUserId: 'user-1',
      stripeRefundId: 're_live_secret',
      policyDecision: 'full_unused_pack',
      amountCents: 1500,
      state: 'pending',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    } as never)
    expect(dto).toEqual({
      policyDecision: 'full_unused_pack',
      amountCents: 1500,
      state: 'pending',
      createdAt: '2026-07-01T00:00:00.000Z',
    })
    expect(dto).not.toHaveProperty('stripeRefundId')
    expect(dto).not.toHaveProperty('requestedByUserId')
    expect(dto).not.toHaveProperty('organizationId')
  })
})
