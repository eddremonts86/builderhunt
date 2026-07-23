import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, organizationMembers, organizations } from '../db/schema'
import { env } from '../env'
import { createBillingCustomer, createBillingSubscription, findBillingCheckoutAttemptByIdempotencyKey } from '../repositories/billing'
import { createSellerProfileVersion, type SellerProfileInput } from './seller-profile'
import { APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES, CheckoutError, createSubscriptionCheckout } from './checkout'
import { BillingProviderError, type CreateCheckoutSessionInput } from './provider'
import type { CheckoutDisclosures } from './consent'
import { FakeBillingProvider } from './fake-provider'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `checkout-${label}-${counter}`
}

async function freshOrgWithOwner(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizationMembers).values({ id: uniqueId('member'), organizationId: orgId, userId, role: 'owner', createdAt: new Date() })
  return { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

const ALL_ACKNOWLEDGED: CheckoutDisclosures = {
  renewal: true,
  amount: true,
  interval: true,
  cancellationRefundPolicy: true,
  creditExpiryNonTransferability: true,
  tax: true,
  total: true,
}

const DENMARK_SELLER_PROFILE: SellerProfileInput = {
  legalName: 'Jane Doe (Sole Trader)',
  publicBusinessAddress: 'Some Street 1, 1000 Copenhagen, Denmark',
  establishmentCountry: 'DK',
  approvedTaxIds: ['DK12345678'],
  supportEmail: 'support@builderhunt.test',
  statementDescriptor: 'BUILDERHUNT',
  countryAllowlist: ['DK'],
  taxRegistrations: [{ country: 'DK', registrationId: 'DK12345678', effectiveAt: '2026-07-23T00:00:00.000Z' }],
  effectiveAt: '2026-07-23T00:00:00.000Z',
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('checkout')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

interface BaseInputOverrides {
  catalogKey?: string
  country?: string
  disclosures?: CheckoutDisclosures
  idempotencyKey?: string
  successUrl?: string
  cancelUrl?: string
}

function baseInput(overrides: BaseInputOverrides = {}) {
  return {
    catalogKey: 'pro_monthly',
    country: 'DK',
    disclosures: ALL_ACKNOWLEDGED,
    idempotencyKey: uniqueId('idem'),
    successUrl: `${env.APP_URL}/settings/billing/return`,
    cancelUrl: `${env.APP_URL}/settings/billing`,
    ...overrides,
  }
}

/** A `BillingProvider`-shaped stub whose `createCheckoutSession` always times out — proves checkout.ts maps a provider timeout to a typed, catchable error. */
class TimeoutProvider extends FakeBillingProvider {
  override async createCheckoutSession(_input: CreateCheckoutSessionInput): Promise<never> {
    throw new BillingProviderError('The provider did not respond in time.', 'timeout')
  }
}

describe('createSubscriptionCheckout', () => {
  let provider: FakeBillingProvider

  beforeEach(() => {
    provider = new FakeBillingProvider()
  })

  it('rejects when billing has never been configured (no seller profile recorded)', async () => {
    const principal = await freshOrgWithOwner()

    await expect(db.transaction((tx) => createSubscriptionCheckout(tx, principal, baseInput(), { provider, sellerProfileDb: db })))
      .rejects.toMatchObject({ code: 'billing_disabled' })
  })

  describe('with a Denmark-only seller profile recorded', () => {
    beforeEach(async () => {
      const platformAdminId = uniqueId('platform-admin')
      await db.insert(authUsers).values({ id: platformAdminId, name: platformAdminId, email: `${platformAdminId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
      await createSellerProfileVersion(DENMARK_SELLER_PROFILE, platformAdminId, db)
    })

    it('creates a Checkout Session and records exactly one Stripe customer for the organization', async () => {
      const principal = await freshOrgWithOwner()

      const result = await db.transaction((tx) => createSubscriptionCheckout(tx, principal, baseInput(), { provider, sellerProfileDb: db }))

      expect(result.status).toBe('complete')
      expect(result.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//)
      expect(await provider.listForReconciliation('customers')).toHaveLength(1)
    })

    it('requests automatic tax, required billing address, tax-ID collection, promotion codes, and only immediate card/wallet methods', async () => {
      const principal = await freshOrgWithOwner()
      const input = baseInput()

      await db.transaction((tx) => createSubscriptionCheckout(tx, principal, input, { provider, sellerProfileDb: db }))

      const attempt = await db.transaction((tx) => findBillingCheckoutAttemptByIdempotencyKey(tx, principal.organizationId, input.idempotencyKey))
      expect(attempt?.stripeCheckoutSessionId).toBeTruthy()
      const session = await provider.getCheckoutSession(attempt!.stripeCheckoutSessionId!)

      expect(session?.automaticTax).toBe(true)
      expect(session?.billingAddressCollection).toBe('required')
      expect(session?.taxIdCollection).toBe(true)
      expect(session?.allowPromotionCodes).toBe(true)
      expect(session?.paymentMethodTypes).toEqual([...APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES])
      expect(session?.mode).toBe('subscription')
    })

    it('rejects a non-Denmark country', async () => {
      const principal = await freshOrgWithOwner()

      await expect(db.transaction((tx) => createSubscriptionCheckout(tx, principal, baseInput({ country: 'US' }), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'country_not_allowed' })
    })

    it('rejects an unknown catalog key (spoofed price/tier cannot be smuggled in this way)', async () => {
      const principal = await freshOrgWithOwner()

      await expect(db.transaction((tx) => createSubscriptionCheckout(tx, principal, baseInput({ catalogKey: 'not_a_real_key' }), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'unknown_catalog_key' })
    })

    it('rejects a successUrl outside this app\'s own origin (spoofed redirect)', async () => {
      const principal = await freshOrgWithOwner()

      await expect(db.transaction((tx) => createSubscriptionCheckout(tx, principal, baseInput({ successUrl: 'https://evil.example.com/success' }), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'invalid_url' })
    })

    it('rejects a cancelUrl outside this app\'s own origin (spoofed redirect)', async () => {
      const principal = await freshOrgWithOwner()

      await expect(db.transaction((tx) => createSubscriptionCheckout(tx, principal, baseInput({ cancelUrl: 'https://evil.example.com/cancel' }), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'invalid_url' })
    })

    it('rejects when an active subscription already exists for this organization', async () => {
      const principal = await freshOrgWithOwner()
      const customerId = uniqueId('customer')
      await db.transaction((tx) => createBillingCustomer(tx, { id: customerId, organizationId: principal.organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` }))
      await db.transaction((tx) => createBillingSubscription(tx, {
        id: uniqueId('sub'), organizationId: principal.organizationId, customerId, livemode: false,
        catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
        stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus: 'active',
      }))

      await expect(db.transaction((tx) => createSubscriptionCheckout(tx, principal, baseInput(), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'subscription_exists' })
    })

    it('a duplicate request (same idempotency key) replays the original session instead of creating a second one', async () => {
      const principal = await freshOrgWithOwner()
      const input = baseInput()

      const first = await db.transaction((tx) => createSubscriptionCheckout(tx, principal, input, { provider, sellerProfileDb: db }))
      const second = await db.transaction((tx) => createSubscriptionCheckout(tx, principal, input, { provider, sellerProfileDb: db }))

      expect(second).toEqual(first)
      expect(await provider.listForReconciliation('customers')).toHaveLength(1)
    })

    it('concurrent requests with the same idempotency key converge on exactly one Checkout Session', async () => {
      const principal = await freshOrgWithOwner()
      const input = baseInput()

      const [first, second] = await Promise.all([
        db.transaction((tx) => createSubscriptionCheckout(tx, principal, input, { provider, sellerProfileDb: db })),
        db.transaction((tx) => createSubscriptionCheckout(tx, principal, input, { provider, sellerProfileDb: db })),
      ])

      expect(first.checkoutUrl).toBe(second.checkoutUrl)
    })

    it('surfaces a provider timeout as a typed CheckoutError, without creating a checkout attempt row', async () => {
      const principal = await freshOrgWithOwner()
      const idempotencyKey = uniqueId('timeout-idem')

      await expect(db.transaction((tx) => createSubscriptionCheckout(
        tx, principal, baseInput({ idempotencyKey }), { provider: new TimeoutProvider(), sellerProfileDb: db },
      ))).rejects.toBeInstanceOf(CheckoutError)

      const attempt = await db.transaction((tx) => findBillingCheckoutAttemptByIdempotencyKey(tx, principal.organizationId, idempotencyKey))
      expect(attempt).toBeNull()
    })

    it('rejects when a required disclosure was not acknowledged, without creating a checkout attempt', async () => {
      const principal = await freshOrgWithOwner()
      const idempotencyKey = uniqueId('missing-disclosure')

      await expect(db.transaction((tx) => createSubscriptionCheckout(
        tx, principal, baseInput({ idempotencyKey, disclosures: { ...ALL_ACKNOWLEDGED, tax: false } }), { provider, sellerProfileDb: db },
      ))).rejects.toMatchObject({ code: 'missing_disclosure' })

      const attempt = await db.transaction((tx) => findBillingCheckoutAttemptByIdempotencyKey(tx, principal.organizationId, idempotencyKey))
      expect(attempt).toBeNull()
    })
  })
})
