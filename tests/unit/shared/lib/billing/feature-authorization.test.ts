import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  ABUSE_ENFORCEMENT_MODE: 'observe' as 'observe' | 'warn' | 'enforce',
  CREDIT_SEAT_DAILY_UNITS: 2000,
  CREDIT_FIRST_PAYER_WINDOW_HOURS: 48,
  CREDIT_FIRST_PAYER_CAP_UNITS: 500,
  CREDIT_REFUND_MAX_PER_DAY: 300,
  CREDIT_REFUND_FARMING_WINDOW_HOURS: 720,
  CREDIT_REFUND_FARMING_RATIO_THRESHOLD: 0.5,
  CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS: 100,
}))
vi.mock('~/shared/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/env')>()
  return {
    ...actual,
    env: {
      ...actual.env,
      get ABUSE_ENFORCEMENT_MODE() { return mockEnv.ABUSE_ENFORCEMENT_MODE },
      get CREDIT_SEAT_DAILY_UNITS() { return mockEnv.CREDIT_SEAT_DAILY_UNITS },
      get CREDIT_FIRST_PAYER_WINDOW_HOURS() { return mockEnv.CREDIT_FIRST_PAYER_WINDOW_HOURS },
      get CREDIT_FIRST_PAYER_CAP_UNITS() { return mockEnv.CREDIT_FIRST_PAYER_CAP_UNITS },
      get CREDIT_REFUND_MAX_PER_DAY() { return mockEnv.CREDIT_REFUND_MAX_PER_DAY },
      get CREDIT_REFUND_FARMING_WINDOW_HOURS() { return mockEnv.CREDIT_REFUND_FARMING_WINDOW_HOURS },
      get CREDIT_REFUND_FARMING_RATIO_THRESHOLD() { return mockEnv.CREDIT_REFUND_FARMING_RATIO_THRESHOLD },
      get CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS() { return mockEnv.CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS },
    },
  }
})

import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, billingSubscriptions, organizations } from '~/shared/lib/db/schema'
import { grantCredits } from '~/shared/lib/billing/credits'
import { findCreditGrant } from '~/shared/lib/repositories/billing-ledger'
import {
  checkEntitlement,
  extendReservation,
  FeatureBillingError,
  refundUsage,
  releaseReservation,
  reserveCredits,
  settleReservation,
} from '~/shared/lib/billing/feature-authorization'

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
  const { billingCustomers } = await import('~/shared/lib/db/schema')
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

/** A paid-source grant (unlike `seedGrant`'s `promotional` default) — makes the org a "payer" for `findEarliestPaidGrantCreatedAt`/the G6 first-payer window. */
async function seedPaidGrant(organizationId: string, units: number): Promise<string> {
  const grantId = uniqueId('grant')
  await db.transaction((tx) => grantCredits(tx, {
    grantId, ledgerEntryId: uniqueId('entry'), organizationId, source: 'pack',
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

afterEach(() => {
  mockEnv.ABUSE_ENFORCEMENT_MODE = 'observe'
  mockEnv.CREDIT_SEAT_DAILY_UNITS = 2000
  mockEnv.CREDIT_FIRST_PAYER_WINDOW_HOURS = 48
  mockEnv.CREDIT_FIRST_PAYER_CAP_UNITS = 500
  mockEnv.CREDIT_REFUND_MAX_PER_DAY = 300
  mockEnv.CREDIT_REFUND_FARMING_WINDOW_HOURS = 720
  mockEnv.CREDIT_REFUND_FARMING_RATIO_THRESHOLD = 0.5
  mockEnv.CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS = 100
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

describe('reserveCredits — per-seat credit sub-budget + pool_drain (abuse-and-usage-integrity G2)', () => {
  function todayUtc(): string {
    return new Date().toISOString().slice(0, 10)
  }

  it('never blocks or flags a single-seat org, however far over the cap its own seat goes', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 1000)
    mockEnv.ABUSE_ENFORCEMENT_MODE = 'enforce'
    mockEnv.CREDIT_SEAT_DAILY_UNITS = 50 // first reservation alone (50 units) already meets the cap

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))
    // Second reservation pushes this seat to 100 units against a 50-unit cap — still not flagged/blocked, solo seat.
    await expect(db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))).resolves.toBeDefined()
    expect(insert).not.toHaveBeenCalled()
  })

  it('observe mode: records usage and emits pool_drain but never blocks a multi-seat org\'s over-cap seat', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 1000)
    mockEnv.CREDIT_SEAT_DAILY_UNITS = 50 // observe mode is the afterEach default

    const { incrementSeatUsage } = await import('~/shared/lib/repositories/seat-usage')
    const otherSeatUserId = uniqueId('user')
    await db.insert(authUsers).values({ id: otherSeatUserId, name: otherSeatUserId, email: `${otherSeatUserId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    await db.transaction((tx) => incrementSeatUsage(tx, {
      id: uniqueId('seat-usage'), organizationId: principal.organizationId, userId: otherSeatUserId,
      day: todayUtc(), action: 'messages', count: 1, creditUnits: 10,
    }))

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    // First reservation (50 units) already exceeds the 50-unit cap is false (== cap, not over); second pushes to 100, over cap.
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))
    await expect(db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))).resolves.toBeDefined() // observe mode: never throws, however over cap

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pool_drain',
      organizationId: principal.organizationId,
      userId: principal.userId,
      details: expect.objectContaining({ seatUnits: 100, cap: 50 }),
    }))
  })

  it('enforce mode: blocks a multi-seat org\'s seat once it would cross the per-seat cap, before any credits are reserved', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 1000)
    mockEnv.ABUSE_ENFORCEMENT_MODE = 'enforce'
    mockEnv.CREDIT_SEAT_DAILY_UNITS = 50

    const { incrementSeatUsage, getSeatUsage } = await import('~/shared/lib/repositories/seat-usage')
    const otherSeatUserId = uniqueId('user')
    await db.insert(authUsers).values({ id: otherSeatUserId, name: otherSeatUserId, email: `${otherSeatUserId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    await db.transaction((tx) => incrementSeatUsage(tx, {
      id: uniqueId('seat-usage'), organizationId: principal.organizationId, userId: otherSeatUserId,
      day: todayUtc(), action: 'messages', count: 1, creditUnits: 10,
    }))

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    // First reservation brings this seat to exactly 50 (== cap, not over) — must succeed.
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))

    // Second reservation would push this seat to 100 (> 50 cap) in a multi-seat org — must block BEFORE reserving.
    await expect(db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))).rejects.toMatchObject({ code: 'blocked' })

    const seatUsageAfterBlock = await db.transaction((tx) => getSeatUsage(tx, principal.organizationId, principal.userId, todayUtc(), 'messages'))
    expect(seatUsageAfterBlock?.creditUnits).toBe(50) // unchanged — the blocked attempt never reserved or recorded anything
  })
})

describe('reserveCredits — first-payer credit-consumption cap + credit_spend_velocity (abuse-and-usage-integrity G6)', () => {
  it('never caps or flags an established payer, however far over the cap it reserves', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedPaidGrant(principal.organizationId, 1000) // just paid moments ago
    mockEnv.ABUSE_ENFORCEMENT_MODE = 'enforce'
    mockEnv.CREDIT_FIRST_PAYER_CAP_UNITS = 50
    mockEnv.CREDIT_FIRST_PAYER_WINDOW_HOURS = 0 // 0-hour window: even a just-created grant is already "outside" it

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    // Two reservations of 50 units each (100 total) — well over the 50-unit cap, but never applies once outside the window.
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))
    await expect(db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))).resolves.toBeDefined()
    expect(insert).not.toHaveBeenCalled()
  })

  it('observe mode: emits credit_spend_velocity but never blocks a new payer over the cap', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedPaidGrant(principal.organizationId, 1000)
    mockEnv.CREDIT_FIRST_PAYER_CAP_UNITS = 50 // observe mode is the afterEach default; window stays the 48h default

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    // First reservation reaches exactly the cap (== 50, not over) — must succeed, no signal yet.
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))
    // Second reservation pushes the window total to 100 (> 50 cap) — observe mode never throws.
    await expect(db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))).resolves.toBeDefined()

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'credit_spend_velocity',
      organizationId: principal.organizationId,
      userId: principal.userId,
      details: expect.objectContaining({ unitsReservedInWindow: 50, thisReservationUnits: 50, cap: 50 }),
    }))
  })

  it('enforce mode: blocks a new payer\'s reservation once the window total would cross the cap, before any credits are reserved', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedPaidGrant(principal.organizationId, 1000)
    mockEnv.ABUSE_ENFORCEMENT_MODE = 'enforce'
    mockEnv.CREDIT_FIRST_PAYER_CAP_UNITS = 50

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    // First reservation reaches exactly the cap (== 50) — must succeed.
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))

    // Second reservation would push the window total to 100 (> 50 cap) — must block BEFORE reserving.
    await expect(db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId: uniqueId('reservation'), operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }, deps))).rejects.toMatchObject({ code: 'blocked' })
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
      settlementId: reservationId, units: 3, reason: 'downstream provider call was itself refunded', idempotencyKey: uniqueId('idem'), providerEvidenceReference: 'evidence-1',
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
      settlementId: reservationId, units: 2, reason: 'refund', idempotencyKey: refundIdempotencyKey, providerEvidenceReference: 'evidence-2',
    }))
    const afterFirst = await db.transaction((tx) => findCreditGrant(tx, principal.organizationId, grantId))

    await db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 2, reason: 'refund', idempotencyKey: refundIdempotencyKey, providerEvidenceReference: 'evidence-2',
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
      settlementId: reservationId, units: 4, reason: 'over-refund attempt', idempotencyKey: uniqueId('idem'), providerEvidenceReference: 'evidence-3',
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
      settlementId: reservationId, units: 1, reason: 'not settled yet', idempotencyKey: uniqueId('idem'), providerEvidenceReference: 'evidence-4',
    }))).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('requires a non-empty provider-evidence reference', async () => {
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
      settlementId: reservationId, units: 1, reason: 'no evidence', idempotencyKey: uniqueId('idem'), providerEvidenceReference: '   ',
    }))).rejects.toMatchObject({ code: 'invalid_state' })
  })
})

describe('refundUsage — refund-farming cap + refund_farming signal (abuse-and-usage-integrity G4)', () => {
  it('enforce mode: blocks once the rolling refund cap would be crossed, before any credits are refunded', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    const grantId = await seedGrant(principal.organizationId, 1000)
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId, operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }))
    await db.transaction((tx) => settleReservation(tx, principal, {
      reservationId, actualUnits: 10, idempotencyKey: uniqueId('idem'),
    }))

    mockEnv.ABUSE_ENFORCEMENT_MODE = 'enforce'
    mockEnv.CREDIT_REFUND_MAX_PER_DAY = 3

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    // First refund reaches exactly the 3-unit cap — must succeed.
    await db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 3, reason: 'partial refund 1', idempotencyKey: uniqueId('idem'), providerEvidenceReference: 'evidence-cap-1',
    }, deps))

    const beforeBlockedAttempt = await db.transaction((tx) => findCreditGrant(tx, principal.organizationId, grantId))

    // Second refund would push the rolling total to 4 (> 3 cap) — must block BEFORE crediting anything.
    await expect(db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 1, reason: 'partial refund 2', idempotencyKey: uniqueId('idem'), providerEvidenceReference: 'evidence-cap-2',
    }, deps))).rejects.toMatchObject({ code: 'blocked' })

    const afterBlockedAttempt = await db.transaction((tx) => findCreditGrant(tx, principal.organizationId, grantId))
    expect(afterBlockedAttempt!.remainingUnits).toBe(beforeBlockedAttempt!.remainingUnits) // unchanged — the blocked attempt never credited anything
  })

  it('observe mode: emits refund_farming but never blocks once the refund-to-settle ratio crosses the threshold', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 1000)
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId, operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }))
    await db.transaction((tx) => settleReservation(tx, principal, {
      reservationId, actualUnits: 20, idempotencyKey: uniqueId('idem'),
    }))

    mockEnv.CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS = 10 // observe mode is the afterEach default

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    // 11/20 = 0.55 > the default 0.5 ratio threshold.
    await expect(db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 11, reason: 'large refund', idempotencyKey: uniqueId('idem'), providerEvidenceReference: 'evidence-ratio',
    }, deps))).resolves.toBeDefined()

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'refund_farming',
      organizationId: principal.organizationId,
      userId: principal.userId,
      details: expect.objectContaining({ refundedUnits: 11, settledUnits: 20, ratio: 0.55 }),
    }))
  })

  it('enforce mode: the ratio signal never blocks by itself — only the daily cap does', async () => {
    const principal = await freshPrincipal()
    await seedSubscription(principal.organizationId, 'pro_max')
    await seedGrant(principal.organizationId, 1000)
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, principal, {
      reservationId, operation: 'ai_sourcing_sprint', idempotencyKey: uniqueId('idem'),
    }))
    await db.transaction((tx) => settleReservation(tx, principal, {
      reservationId, actualUnits: 20, idempotencyKey: uniqueId('idem'),
    }))

    mockEnv.ABUSE_ENFORCEMENT_MODE = 'enforce'
    mockEnv.CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS = 10
    // Daily cap left at the default 300 — well above this refund, so only the ratio should fire.

    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    await expect(db.transaction((tx) => refundUsage(tx, principal, {
      settlementId: reservationId, units: 11, reason: 'large refund', idempotencyKey: uniqueId('idem'), providerEvidenceReference: 'evidence-ratio-enforce',
    }, deps))).resolves.toBeDefined()

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ type: 'refund_farming' }))
  })
})
