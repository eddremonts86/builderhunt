/**
 * The balance/action DTO, against a real disposable Postgres and the real billing platform.
 *
 * Same reasoning as `billing.test.ts`: the point of this DTO is that it agrees with what `reserveCredits` will
 * actually do, and a faked balance would let it disagree while every assertion passed. Several tests here assert
 * the agreement directly — the DTO says available, so the reservation must succeed; it says
 * `insufficient_credits`, so the reservation must fail.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { grantCredits } from '~/shared/lib/billing/credits'
import { authUsers, billingCustomers, billingSubscriptions, organizations } from '~/shared/lib/db/schema'
import { RATE_CARDS } from '~/shared/lib/billing/rate-cards'
import { tenantTransaction } from '../../helpers/tenant-transaction'

const flagState = vi.hoisted(() => ({ paidGenerationEnabled: true }))
vi.mock('~/shared/lib/solutions/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/solutions/config')>()
  return {
    ...actual,
    getSolutionsFeatureFlags: () => ({
      ...actual.getSolutionsFeatureFlags(),
      paidGenerationEnabled: flagState.paidGenerationEnabled,
    }),
  }
})

const { describeSolutionsBillingState } = await import('~/modules/solutions/server/billing-state')
const { withSolutionsCredits } = await import('~/modules/solutions/server/billing')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const GENERATE_PRICE = RATE_CARDS.solutions_generate.maxUnits
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)
let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

const USER = 'bs-user'
let ORG = ''
let principal = {} as never

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('solutions_billing_state')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: USER, name: 'Owner', email: 'bs-user@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 180_000)

afterAll(async () => { await drop() })

async function freshOrganization(tier: 'pro' | 'pro_max' | 'team' | 'free', stripeStatus = 'active') {
  ORG = uniqueId('bs-org')
  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: ORG })
  principal = { organizationId: ORG, userId: USER, organizationRole: 'owner', requestId: uniqueId('req') } as never
  if (tier === 'free') return
  const customerId = uniqueId('customer')
  await db.insert(billingCustomers).values({
    id: customerId, organizationId: ORG, livemode: false,
    stripeCustomerId: `cus_${customerId}`, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(billingSubscriptions).values({
    id: uniqueId('sub'), organizationId: ORG, customerId, livemode: false,
    catalogKey: `${tier}_monthly`, tier, interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus, providerSyncedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(),
  })
}

async function seedCredits(units: number) {
  await tenantTransaction(db, ORG, (tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
    source: 'promotional', units, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
}

const state = () => tenantTransaction(db, ORG, (tx) => describeSolutionsBillingState(tx as never, principal))

const attemptGenerate = () => tenantTransaction(db, ORG, (tx) => withSolutionsCredits(
  tx as never, principal,
  {
    operation: 'generate',
    reservationId: uniqueId('res'),
    idempotencyKey: uniqueId('idem'),
    confirmation: { acceptedUnits: GENERATE_PRICE, acceptedRateCardVersion: RATE_CARDS.solutions_generate.version },
  },
  async () => ({ result: 'ok', usable: true, providerInvoked: true, providerReference: null }),
))

describe('describeSolutionsBillingState', () => {
  it('offers both operations to a funded paid organization', async () => {
    await freshOrganization('pro')
    await seedCredits(100)
    const dto = await state()
    expect(dto.balanceUnits).toBe(100)
    expect(dto.generate).toMatchObject({ available: true, unavailableReason: null })
    expect(dto.regenerate).toMatchObject({ available: true, unavailableReason: null })
    // The exact charge, so the page can display it and echo it back.
    expect(dto.generate.charge).toEqual({
      operation: 'generate', units: GENERATE_PRICE, rateCardVersion: RATE_CARDS.solutions_generate.version,
    })
  })

  it('reports the price even when the operation is unavailable', async () => {
    // A user who cannot afford a run still needs to be told what it would cost — that is the whole content of
    // the upsell. Withholding the price until they qualify makes the refusal unexplainable.
    await freshOrganization('free')
    const dto = await state()
    expect(dto.generate.available).toBe(false)
    expect(dto.generate.charge.units).toBe(GENERATE_PRICE)
  })

  it('names the flag rather than the tier when the feature is off', async () => {
    // A Pro organization with credits is entitled and funded; saying `tier_too_low` would send them to buy an
    // upgrade that changes nothing.
    await freshOrganization('pro')
    await seedCredits(100)
    flagState.paidGenerationEnabled = false
    try {
      expect((await state()).generate.unavailableReason).toBe('feature_disabled')
    } finally {
      flagState.paidGenerationEnabled = true
    }
  })

  it('distinguishes no subscription from a tier that is too low', async () => {
    await freshOrganization('free')
    await seedCredits(100)
    expect((await state()).generate.unavailableReason).toBe('no_subscription')
    // There is no paid tier below `pro` today, so `tier_too_low` is only reachable by raising the card's floor —
    // which is exactly the change that must keep producing the upgrade message rather than a generic refusal.
    await freshOrganization('pro')
    await seedCredits(100)
    const original = { ...RATE_CARDS.solutions_generate }
    RATE_CARDS.solutions_generate = { ...original, minimumTier: 'pro_max' }
    try {
      expect((await state()).generate.unavailableReason).toBe('tier_too_low')
    } finally {
      RATE_CARDS.solutions_generate = original
    }
  })

  it('reports insufficient credits separately from entitlement', async () => {
    await freshOrganization('pro')
    await seedCredits(GENERATE_PRICE - 1)
    const dto = await state()
    expect(dto.generate).toMatchObject({ available: false, unavailableReason: 'insufficient_credits' })
    // Regenerate is cheaper, so the same balance may still afford it. The two actions are decided against one
    // balance read but against their own prices.
    expect(dto.regenerate.available).toBe(true)
  })

  it('offers a run to an organization holding exactly the price', async () => {
    // `<` not `<=`: an exact balance affords exactly one run, and refusing it would strand the last credits of
    // every organization.
    await freshOrganization('pro')
    await seedCredits(GENERATE_PRICE)
    expect((await state()).generate.available).toBe(true)
  })

  it('excludes expired grants from the balance it reports', async () => {
    await freshOrganization('pro')
    await tenantTransaction(db, ORG, (tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
      source: 'promotional', units: 500, expiresAt: new Date(Date.now() - 1000), idempotencyKey: uniqueId('idem'),
    }))
    const dto = await state()
    expect(dto.balanceUnits).toBe(0)
    expect(dto.generate.unavailableReason).toBe('insufficient_credits')
  })
})

describe('the DTO agrees with what the reservation actually does', () => {
  it('a run the DTO offered succeeds', async () => {
    await freshOrganization('pro')
    await seedCredits(GENERATE_PRICE)
    expect((await state()).generate.available).toBe(true)
    expect((await attemptGenerate()).settledUnits).toBe(GENERATE_PRICE)
  })

  it('a run the DTO refused for credits is also refused by the reservation', async () => {
    /**
     * The disagreement this DTO exists to prevent, asserted from both sides. An enabled button whose charge the
     * platform then refuses is worse than a disabled one: the user has already confirmed a price by then.
     */
    await freshOrganization('pro')
    await seedCredits(GENERATE_PRICE - 1)
    expect((await state()).generate.unavailableReason).toBe('insufficient_credits')
    await expect(attemptGenerate()).rejects.toThrow()
  })

  it('a run the DTO refused for entitlement is also refused by the reservation', async () => {
    await freshOrganization('free')
    await seedCredits(100)
    expect((await state()).generate.unavailableReason).toBe('no_subscription')
    await expect(attemptGenerate()).rejects.toMatchObject({ code: 'insufficient_entitlement' })
  })

  it('the balance it reports drops by exactly the price after a run', async () => {
    await freshOrganization('pro')
    await seedCredits(100)
    await attemptGenerate()
    expect((await state()).balanceUnits).toBe(100 - GENERATE_PRICE)
  })

  it('reports the balance unchanged after a released run', async () => {
    // The hold went back, so the next run must be offered against the full balance.
    await freshOrganization('pro')
    await seedCredits(100)
    await tenantTransaction(db, ORG, (tx) => withSolutionsCredits(
      tx as never, principal,
      {
        operation: 'generate',
        reservationId: uniqueId('res'),
        idempotencyKey: uniqueId('idem'),
        confirmation: { acceptedUnits: GENERATE_PRICE, acceptedRateCardVersion: RATE_CARDS.solutions_generate.version },
      },
      async () => ({ result: 'nothing usable', usable: false, providerInvoked: true, providerReference: null }),
    ))
    expect((await state()).balanceUnits).toBe(100)
  })
})
