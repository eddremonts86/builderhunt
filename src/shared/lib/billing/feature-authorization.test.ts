import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingSubscriptions, organizations } from '../db/schema'
import { grantCredits } from './credits'
import { findCreditGrant } from '../repositories/billing-ledger'
import {
  checkEntitlement,
  extendReservation,
  FeatureBillingError,
  refundUsage,
  releaseReservation,
  reserveCredits,
  settleReservation,
} from './feature-authorization'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `feat-${label}-${counter}`
}

async function freshPrincipal(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  return { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

async function seedSubscription(organizationId: string, tier: 'pro' | 'pro_max' | 'team', stripeStatus = 'active'): Promise<void> {
  const customerId = uniqueId('customer')
  const { billingCustomers } = await import('../db/schema')
  await db.insert(billingCustomers).values({
    id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}`, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(billingSubscriptions).values({
    id: uniqueId('sub'), organizationId, customerId, livemode: false,
    catalogKey: `${tier}_monthly`, tier, interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus, providerSyncedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(),
  })
}

async function seedGrant(organizationId: string, units: number): Promise<string> {
  const grantId = uniqueId('grant')
  await db.transaction((tx) => grantCredits(tx, {
    grantId, ledgerEntryId: uniqueId('entry'), organizationId, source: 'promotional',
    units, expiresAt: new Date(Date.now() + 30 * 86_400_000), idempotencyKey: uniqueId('idem'),
  }))
  return grantId
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('feature_authorization')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('checkEntitlement', () => {
  it('rejects an unknown feature', async () => {
    const principal = await freshPrincipal()
    const result = await db.transaction((tx) => checkEntitlement(tx, principal, { feature: 'not_a_real_feature' }))
    expect(result).toEqual({ allowed: false, reason: 'unknown_feature' })
  })

  it('rejects an organization with no subscription for a tier-gated feature', async () => {
    const principal = await freshPrincipal()
    const result = await db.transaction((tx) => checkEntitlement(tx, principal, { feature: 'ai_sourcing_sprint' }))
    expect(result).toEqual({ allowed: false, reason: 'no_subscription' })
  })

  it('rejects a subscription whose tier is below the feature\'s minimum', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro')
    const result = await db.transaction((tx) => checkEntitlement(tx, principal, { feature: 'ai_sourcing_sprint' }))
    expect(result).toEqual({ allowed: false, reason: 'tier_too_low' })
  })

  it('allows a subscription that meets the feature\'s minimum tier', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    const result = await db.transaction((tx) => checkEntitlement(tx, principal, { feature: 'ai_sourcing_sprint' }))
    expect(result).toEqual({ allowed: true })
  })

  it('treats team the same as pro_max for a pro_max-gated feature', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'team')
    const result = await db.transaction((tx) => checkEntitlement(tx, principal, { feature: 'ai_sourcing_sprint' }))
    expect(result).toEqual({ allowed: true })
  })
})

describe('reserveCredits (feature layer)', () => {
  it('throws insufficient_entitlement before ever touching the credit ledger', async () => {
    const principal = await freshPrincipal()
    await seedGrant(principal.organizationId, 1000) // plenty of credits, but no subscription at all
    await expect(db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }))).rejects.toMatchObject({ code: 'insufficient_entitlement' })
  })

  it('throws insufficient_credits when entitled but the organization has no balance', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await expect(db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }))).rejects.toMatchObject({ code: 'insufficient_credits' })
  })

  it('reserves exactly the rate card\'s maxUnits — client cannot request a different amount', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 1000)
    const result = await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }))
    expect(result.reservation.maximumUnits).toBe(50) // RATE_CARDS.ai_sourcing_sprint.maxUnits
  })
})

describe('fake feature/provider integration — no provider call before reservation, stops on extend failure', () => {
  it('never calls the provider before reserveCredits resolves', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 1000)

    let providerCalled = false
    const fakeProvider = () => { providerCalled = true }

    await db.transaction(async (tx) => {
      // A feature implementation would look exactly like this: reserve first, provider call only after.
      expect(providerCalled).toBe(false)
      await reserveCredits(tx, principal, {
        reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
      })
      expect(providerCalled).toBe(false) // still false — reservation succeeding does not itself call the provider
      fakeProvider()
      expect(providerCalled).toBe(true)
    })
  })

  it('never calls the provider at all when reserveCredits throws', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    // No grant seeded — reservation must fail for insufficient credits.

    let providerCalled = false
    const fakeProvider = () => { providerCalled = true }

    async function fakeFeature() {
      await db.transaction(async (tx) => {
        await reserveCredits(tx, principal, {
          reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
        })
        fakeProvider() // must never be reached
      })
    }

    await expect(fakeFeature()).rejects.toMatchObject({ code: 'insufficient_credits' })
    expect(providerCalled).toBe(false)
  })

  it('stops simulated provider work as soon as extendReservation fails mid-operation', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 60) // enough for the initial 50-unit reserve, not enough to extend by much more

    let providerUnitsProcessed = 0
    const reservationId = uniqueId('reservation')

    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId, operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }))
    providerUnitsProcessed += 50 // simulated provider work done under the initial reservation

    // Simulated long-running operation needs more budget than remains (60 - 50 = 10 available).
    let stoppedOnExtendFailure = false
    try {
      await db.transaction((tx) => extendReservation(tx, principal, {
        reservationId, additionalMaximumUnits: 40, idempotencyKey: uniqueId('idem'),
      }))
      providerUnitsProcessed += 40 // must never execute
    } catch (error) {
      expect(error).toBeInstanceOf(FeatureBillingError)
      expect((error as FeatureBillingError).code).toBe('insufficient_credits')
      stoppedOnExtendFailure = true
      // The simulated feature must stop here — no further provider work, no further spend attempt.
    }

    expect(stoppedOnExtendFailure).toBe(true)
    expect(providerUnitsProcessed).toBe(50) // only the initially-reserved work happened, nothing from the failed extension

    await db.transaction((tx) => releaseReservation(tx, principal, {
      reservationId, idempotencyKey: uniqueId('idem'), reason: 'operation stopped after failed extension',
    }))
  })
})

describe('refundUsage', () => {
  it('credits a partial refund back to the still-active source grant', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    const grantId = await seedGrant(principal.organizationId, 100)
    const reservationId = uniqueId('reservation')

    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId, operation: 'semantic_search_query', idempotencyKey: uniqueId('idem'),
    }))
    // semantic_search_query rate card maxUnits is 5.
    await db.transaction((tx) => settleReservation(tx, principal, {
      reservationId, actualUnits: 5, idempotencyKey: uniqueId('idem'),
    }))

    const beforeRefund = await db.transaction((tx) => findCreditGrant(tx, principal.organizationId, grantId))
    const refund = await db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 3, reason: 'downstream provider call was itself refunded', idempotencyKey: uniqueId('idem'),
    }))
    expect(refund.refundedUnits).toBe(3)

    const afterRefund = await db.transaction((tx) => findCreditGrant(tx, principal.organizationId, grantId))
    expect(afterRefund!.remainingUnits).toBe(beforeRefund!.remainingUnits + 3)
  })

  it('replays a duplicate refund idempotency key instead of refunding twice', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    const grantId = await seedGrant(principal.organizationId, 100)
    const reservationId = uniqueId('reservation')

    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId, operation: 'semantic_search_query', idempotencyKey: uniqueId('idem'),
    }))
    await db.transaction((tx) => settleReservation(tx, principal, {
      reservationId, actualUnits: 5, idempotencyKey: uniqueId('idem'),
    }))

    const refundIdempotencyKey = uniqueId('idem')
    await db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 2, reason: 'refund', idempotencyKey: refundIdempotencyKey,
    }))
    const afterFirst = await db.transaction((tx) => findCreditGrant(tx, principal.organizationId, grantId))

    await db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 2, reason: 'refund', idempotencyKey: refundIdempotencyKey,
    }))
    const afterSecond = await db.transaction((tx) => findCreditGrant(tx, principal.organizationId, grantId))

    expect(afterSecond!.remainingUnits).toBe(afterFirst!.remainingUnits)
  })

  it('refuses to refund more units than were actually settled', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 100)
    const reservationId = uniqueId('reservation')

    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId, operation: 'semantic_search_query', idempotencyKey: uniqueId('idem'),
    }))
    await db.transaction((tx) => settleReservation(tx, principal, {
      reservationId, actualUnits: 3, idempotencyKey: uniqueId('idem'),
    }))

    await expect(db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 4, reason: 'over-refund attempt', idempotencyKey: uniqueId('idem'),
    }))).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('refuses to refund a reservation that was never settled', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 100)
    const reservationId = uniqueId('reservation')

    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId, operation: 'semantic_search_query', idempotencyKey: uniqueId('idem'),
    }))

    await expect(db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 1, reason: 'not settled yet', idempotencyKey: uniqueId('idem'),
    }))).rejects.toMatchObject({ code: 'invalid_state' })
  })
})
