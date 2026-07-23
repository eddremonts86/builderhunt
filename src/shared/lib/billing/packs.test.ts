import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingCreditGrants, organizationMembers, organizations } from '../db/schema'
import { env } from '../env'
import { createBillingCustomer, createBillingSubscription, findBillingCheckoutAttemptByIdempotencyKey } from '../repositories/billing'
import { PACK_CATALOG } from './catalog'
import { createSellerProfileVersion, type SellerProfileInput } from './seller-profile'
import {
  APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES,
} from './checkout'
import {
  assertWithinRollingPackChargeLimit,
  createPackCheckout,
  PackCheckoutError,
  ROLLING_RISK_MAX_AMOUNT_CENTS,
  ROLLING_RISK_MAX_CHARGES,
} from './packs'
import { BillingProviderError, type CreateCheckoutSessionInput } from './provider'
import type { CheckoutDisclosures } from './consent'
import { FakeBillingProvider } from './fake-provider'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `packs-${label}-${counter}`
}

async function freshOrgWithOwner(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizationMembers).values({ id: uniqueId('member'), organizationId: orgId, userId, role: 'owner', createdAt: new Date() })
  return { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

/** Gives an organization an active paid subscription — packs require one before Checkout can even start. */
async function grantActiveSubscription(organizationId: string, stripeStatus = 'active'): Promise<void> {
  const customerId = uniqueId('customer')
  await db.transaction((tx) => createBillingCustomer(tx, { id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` }))
  await db.transaction((tx) => createBillingSubscription(tx, {
    id: uniqueId('sub'), organizationId, customerId, livemode: false,
    catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus,
  }))
}

/** Directly seeds `count` past-successful pack grants (as the pack webhook handler would have created them) at `createdAt`, for the rolling risk-limit tests — a limit that counts completed charges, not merely started Checkout attempts. */
async function seedPackGrants(organizationId: string, count: number, packCatalogKey: string, createdAt: Date): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = uniqueId('grant')
    await db.insert(billingCreditGrants).values({
      id, organizationId, source: 'pack', sourceReference: packCatalogKey,
      originalUnits: 1, remainingUnits: 1, expiresAt: new Date('2099-01-01T00:00:00Z'), createdAt,
    })
  }
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
  const disposable = await createDisposableTestDatabase('packs')
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
    catalogKey: 'starter_300',
    country: 'DK',
    disclosures: ALL_ACKNOWLEDGED,
    idempotencyKey: uniqueId('idem'),
    successUrl: `${env.APP_URL}/settings/billing/return`,
    cancelUrl: `${env.APP_URL}/settings/billing`,
    ...overrides,
  }
}

class TimeoutProvider extends FakeBillingProvider {
  override async createCheckoutSession(_input: CreateCheckoutSessionInput): Promise<never> {
    throw new BillingProviderError('The provider did not respond in time.', 'timeout')
  }
}

describe('createPackCheckout', () => {
  let provider: FakeBillingProvider

  beforeEach(() => {
    provider = new FakeBillingProvider()
  })

  it('rejects when billing has never been configured (no seller profile recorded)', async () => {
    const principal = await freshOrgWithOwner()
    await grantActiveSubscription(principal.organizationId)

    await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput(), { provider, sellerProfileDb: db })))
      .rejects.toMatchObject({ code: 'billing_disabled' })
  })

  describe('with a Denmark-only seller profile recorded', () => {
    beforeEach(async () => {
      const platformAdminId = uniqueId('platform-admin')
      await db.insert(authUsers).values({ id: platformAdminId, name: platformAdminId, email: `${platformAdminId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
      await createSellerProfileVersion(DENMARK_SELLER_PROFILE, platformAdminId, db)
    })

    it('rejects when the organization has no active paid subscription', async () => {
      const principal = await freshOrgWithOwner()

      await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput(), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'no_active_subscription' })
    })

    it('rejects when the subscription exists but has lapsed (past_due is not active/trialing)', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId, 'past_due')

      await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput(), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'no_active_subscription' })
    })

    it('creates a payment-mode Checkout Session with promotion codes disabled and only immediate methods', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)
      const input = baseInput()

      const result = await db.transaction((tx) => createPackCheckout(tx, principal, input, { provider, sellerProfileDb: db }))

      expect(result.status).toBe('complete')
      const attempt = await db.transaction((tx) => findBillingCheckoutAttemptByIdempotencyKey(tx, principal.organizationId, input.idempotencyKey))
      expect(attempt?.action).toBe('credits')
      const session = await provider.getCheckoutSession(attempt!.stripeCheckoutSessionId!)
      expect(session?.mode).toBe('payment')
      expect(session?.allowPromotionCodes).toBe(false)
      expect(session?.paymentMethodTypes).toEqual([...APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES])
    })

    it('rejects a non-Denmark country', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)

      await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput({ country: 'US' }), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'country_not_allowed' })
    })

    it('rejects an unknown pack catalog key', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)

      await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput({ catalogKey: 'not_a_real_pack' }), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'unknown_catalog_key' })
    })

    it('rejects a spoofed successUrl/cancelUrl outside this app\'s own origin', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)

      await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput({ successUrl: 'https://evil.example.com/success' }), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'invalid_url' })
      await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput({ cancelUrl: 'https://evil.example.com/cancel' }), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'invalid_url' })
    })

    it('rejects when a required disclosure was not acknowledged, without creating a checkout attempt', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)
      const idempotencyKey = uniqueId('missing-disclosure')

      await expect(db.transaction((tx) => createPackCheckout(
        tx, principal, baseInput({ idempotencyKey, disclosures: { ...ALL_ACKNOWLEDGED, tax: false } }), { provider, sellerProfileDb: db },
      ))).rejects.toMatchObject({ code: 'missing_disclosure' })

      const attempt = await db.transaction((tx) => findBillingCheckoutAttemptByIdempotencyKey(tx, principal.organizationId, idempotencyKey))
      expect(attempt).toBeNull()
    })

    it('a duplicate request (same idempotency key) replays the original session instead of creating a second one', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)
      const input = baseInput()

      const first = await db.transaction((tx) => createPackCheckout(tx, principal, input, { provider, sellerProfileDb: db }))
      const second = await db.transaction((tx) => createPackCheckout(tx, principal, input, { provider, sellerProfileDb: db }))

      expect(second).toEqual(first)
      expect(await provider.listForReconciliation('payment_intents')).toHaveLength(0)
      // grantActiveSubscription already provisioned this org's billing_customers row directly (as a
      // real subscribed org would have one before ever buying a pack) — `ensureBillingCustomer`
      // correctly finds it and never calls the provider a second time, so 0 (not 1) provider-created
      // customers is the right assertion here, unlike `checkout.test.ts`'s equivalent case where no
      // customer row pre-exists.
      expect(await provider.listForReconciliation('customers')).toHaveLength(0)
    })

    it('concurrent requests with the same idempotency key converge on exactly one Checkout Session', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)
      const input = baseInput()

      const [first, second] = await Promise.all([
        db.transaction((tx) => createPackCheckout(tx, principal, input, { provider, sellerProfileDb: db })),
        db.transaction((tx) => createPackCheckout(tx, principal, input, { provider, sellerProfileDb: db })),
      ])

      expect(first.checkoutUrl).toBe(second.checkoutUrl)
    })

    it('surfaces a provider timeout as a typed PackCheckoutError, without creating a checkout attempt row', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)
      const idempotencyKey = uniqueId('timeout-idem')

      await expect(db.transaction((tx) => createPackCheckout(
        tx, principal, baseInput({ idempotencyKey }), { provider: new TimeoutProvider(), sellerProfileDb: db },
      ))).rejects.toBeInstanceOf(PackCheckoutError)

      const attempt = await db.transaction((tx) => findBillingCheckoutAttemptByIdempotencyKey(tx, principal.organizationId, idempotencyKey))
      expect(attempt).toBeNull()
    })

    it('blocks a pack purchase once the org already has 3 successful pack charges in the trailing 24h', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)
      await seedPackGrants(principal.organizationId, ROLLING_RISK_MAX_CHARGES, 'starter_300', new Date())

      await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput(), { provider, sellerProfileDb: db })))
        .rejects.toMatchObject({ code: 'risk_limit_exceeded' })
    })

    it('does not count a pack charge from outside the trailing 24h window', async () => {
      const principal = await freshOrgWithOwner()
      await grantActiveSubscription(principal.organizationId)
      const outsideWindow = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await seedPackGrants(principal.organizationId, ROLLING_RISK_MAX_CHARGES, 'starter_300', outsideWindow)

      await expect(db.transaction((tx) => createPackCheckout(tx, principal, baseInput(), { provider, sellerProfileDb: db })))
        .resolves.toMatchObject({ status: 'complete' })
    })
  })
})

describe('assertWithinRollingPackChargeLimit', () => {
  it('allows a purchase within both the count and dollar-amount ceilings', async () => {
    const principal = await freshOrgWithOwner()
    await expect(db.transaction((tx) => assertWithinRollingPackChargeLimit(tx, principal.organizationId, PACK_CATALOG.max_5000.amountCents)))
      .resolves.toBeUndefined()
  })

  it('rejects when the incoming charge alone would push the trailing-24h total over $1,000', async () => {
    const principal = await freshOrgWithOwner()
    await expect(db.transaction((tx) => assertWithinRollingPackChargeLimit(tx, principal.organizationId, ROLLING_RISK_MAX_AMOUNT_CENTS + 1)))
      .rejects.toMatchObject({ code: 'risk_limit_exceeded' })
  })

  it('rejects when one recent pack purchase plus the incoming charge would push the total over $1,000, at the exact boundary', async () => {
    const principal = await freshOrgWithOwner()
    await seedPackGrants(principal.organizationId, 1, 'max_5000', new Date())
    const remainingBudgetCents = ROLLING_RISK_MAX_AMOUNT_CENTS - PACK_CATALOG.max_5000.amountCents

    await expect(db.transaction((tx) => assertWithinRollingPackChargeLimit(tx, principal.organizationId, remainingBudgetCents)))
      .resolves.toBeUndefined()
    await expect(db.transaction((tx) => assertWithinRollingPackChargeLimit(tx, principal.organizationId, remainingBudgetCents + 1)))
      .rejects.toMatchObject({ code: 'risk_limit_exceeded' })
  })
})
