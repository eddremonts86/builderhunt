import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grantCredits } from './credits'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { billingCreditGrants, billingLedgerEntries, organizations } from '../db/schema'
import { findCreditGrant } from '../repositories/billing-ledger'
import {
  extendReservation,
  heartbeatReservation,
  releaseReservation,
  ReservationError,
  reserveCredits,
  settleReservation,
} from './reservations'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `resv-${label}-${counter}`
}

/** Every test gets its own organization — grants must never be shared across tests, since earliest-expiry allocation would otherwise silently draw from a DIFFERENT test's leftover grants. */
async function freshOrg(): Promise<string> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  return orgId
}

async function seedGrant(organizationId: string, units: number, expiresAt: Date): Promise<string> {
  const grantId = uniqueId('grant')
  await db.transaction((tx) => grantCredits(tx, {
    grantId, ledgerEntryId: uniqueId('entry'), organizationId, source: 'promotional',
    units, expiresAt, idempotencyKey: uniqueId('idem'),
  }))
  return grantId
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('billing_reservations')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => {
  await drop()
})

const FAR_FUTURE = () => new Date(Date.now() + 30 * 86_400_000)

describe('reserveCredits', () => {
  it('allocates from an eligible grant and decrements its remainingUnits', async () => {
    const orgId = await freshOrg()
    const grantId = await seedGrant(orgId, 100, FAR_FUTURE())
    const result = await db.transaction((tx) => reserveCredits(tx, {
      reservationId: uniqueId('reservation'), organizationId: orgId, operation: 'ai_task',
      rateCardVersion: 1, idempotencyKey: uniqueId('idem'), maximumUnits: 50, maxDurationSeconds: 300,
    }))
    expect(result.reservation.state).toBe('reserved')
    expect(result.reservation.maximumUnits).toBe(50)
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0].allocatedUnits).toBe(50)

    const grant = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))
    expect(grant?.remainingUnits).toBe(50)
  })

  it('rejects a reservation when the organization has insufficient credits, leaving grants untouched', async () => {
    const orgId = await freshOrg()
    const grantId = await seedGrant(orgId, 20, FAR_FUTURE())
    const before = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))

    await expect(db.transaction((tx) => reserveCredits(tx, {
      reservationId: uniqueId('reservation'), organizationId: orgId, operation: 'ai_task',
      rateCardVersion: 1, idempotencyKey: uniqueId('idem'), maximumUnits: 9999, maxDurationSeconds: 300,
    }))).rejects.toThrow(ReservationError)

    const after = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))
    expect(after?.remainingUnits).toBe(before?.remainingUnits)
  })

  it('replays the original reservation for a duplicate idempotency key instead of reserving twice', async () => {
    const orgId = await freshOrg()
    const grantId = await seedGrant(orgId, 200, FAR_FUTURE())
    const idempotencyKey = uniqueId('idem')
    const input = {
      reservationId: uniqueId('reservation'), organizationId: orgId, operation: 'ai_task',
      rateCardVersion: 1, idempotencyKey, maximumUnits: 30, maxDurationSeconds: 300,
    }
    const first = await db.transaction((tx) => reserveCredits(tx, input))
    const second = await db.transaction((tx) => reserveCredits(tx, { ...input, reservationId: uniqueId('reservation') }))
    expect(second.replayed).toBe(true)
    expect(second.reservation.id).toBe(first.reservation.id)
    // Not just the `replayed` flag — confirm the grant was only ever decremented once (200 - 30 =
    // 170), i.e. the replay genuinely skipped a second allocation rather than merely reporting one.
    const grant = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))
    expect(grant?.remainingUnits).toBe(170)
  })

  it('splits allocation across multiple grants, earliest expiry first', async () => {
    const orgId = await freshOrg()
    const now = Date.now()
    await seedGrant(orgId, 30, new Date(now + 2 * 86_400_000))
    await seedGrant(orgId, 100, new Date(now + 60 * 86_400_000))

    const result = await db.transaction((tx) => reserveCredits(tx, {
      reservationId: uniqueId('reservation'), organizationId: orgId, operation: 'ai_task',
      rateCardVersion: 1, idempotencyKey: uniqueId('idem'), maximumUnits: 50, maxDurationSeconds: 300,
    }))
    expect(result.allocations.length).toBeGreaterThanOrEqual(2)
    const total = result.allocations.reduce((sum, allocation) => sum + allocation.allocatedUnits, 0)
    expect(total).toBe(50)
  })
})

describe('extendReservation', () => {
  it('increases maximumUnits and allocates the additional units', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 200, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 20, maxDurationSeconds: 300,
    }))
    const extended = await db.transaction((tx) => extendReservation(tx, {
      organizationId: orgId, reservationId, additionalMaximumUnits: 15, idempotencyKey: uniqueId('idem'),
    }))
    expect(extended.reservation.maximumUnits).toBe(35)
  })

  it('replays the original extension for a duplicate idempotency key instead of extending twice', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 200, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 20, maxDurationSeconds: 300,
    }))
    const extendIdempotencyKey = uniqueId('idem')
    const first = await db.transaction((tx) => extendReservation(tx, {
      organizationId: orgId, reservationId, additionalMaximumUnits: 10, idempotencyKey: extendIdempotencyKey,
    }))
    const second = await db.transaction((tx) => extendReservation(tx, {
      organizationId: orgId, reservationId, additionalMaximumUnits: 10, idempotencyKey: extendIdempotencyKey,
    }))
    expect(second.replayed).toBe(true)
    expect(second.reservation.maximumUnits).toBe(first.reservation.maximumUnits)
    expect(second.reservation.maximumUnits).toBe(30)
  })

  it('refuses to extend a reservation past its deadline (abandoned heartbeat)', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 100, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 10, maxDurationSeconds: 1,
    }))
    const wellPastDeadline = new Date(Date.now() + 60_000)
    await expect(db.transaction((tx) => extendReservation(tx, {
      organizationId: orgId, reservationId, additionalMaximumUnits: 5, idempotencyKey: uniqueId('idem'),
    }, wellPastDeadline))).rejects.toThrow(ReservationError)
  })
})

describe('heartbeatReservation', () => {
  it('refreshes heartbeatAt for a live reservation', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 50, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 10, maxDurationSeconds: 300,
    }))
    const later = new Date(Date.now() + 10_000)
    const result = await db.transaction((tx) => heartbeatReservation(tx, { organizationId: orgId, reservationId }, later))
    expect(result.heartbeatAt.getTime()).toBe(later.getTime())
  })

  it('refuses to heartbeat an abandoned (past-deadline) reservation', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 50, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 10, maxDurationSeconds: 1,
    }))
    await expect(db.transaction((tx) => heartbeatReservation(
      tx, { organizationId: orgId, reservationId }, new Date(Date.now() + 60_000),
    ))).rejects.toThrow(ReservationError)
  })
})

describe('settleReservation', () => {
  it('fully consumes an allocation with no leftover to release', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 100, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 40, maxDurationSeconds: 300,
    }))
    const result = await db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId, actualUnits: 40, idempotencyKey: uniqueId('idem'), settlementGraceSeconds: 60,
    }))
    expect(result.reservation.state).toBe('settled')
    expect(result.reservation.settledUnits).toBe(40)
    expect(result.allocations[0].consumedUnits).toBe(40)
  })

  it('releases the unconsumed remainder back to a still-valid grant', async () => {
    const orgId = await freshOrg()
    const grantId = await seedGrant(orgId, 100, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 60, maxDurationSeconds: 300,
    }))
    await db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId, actualUnits: 25, idempotencyKey: uniqueId('idem'), settlementGraceSeconds: 60,
    }))

    const grant = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))
    // 100 original -> 60 reserved out at reserve time (remainingUnits=40) -> settle 25 consumed, 35 released back -> 40 + 35 = 75.
    expect(grant?.remainingUnits).toBe(75)
  })

  it('forfeits (does not release) the unconsumed remainder when the source grant has expired since reservation ("boundary expiry")', async () => {
    const orgId = await freshOrg()
    const now = Date.now()
    const grantId = await seedGrant(orgId, 50, new Date(now + 5000))
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 50, maxDurationSeconds: 3600,
    }, new Date(now)))

    const afterGrantExpiry = new Date(now + 10_000)
    await db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId, actualUnits: 20, idempotencyKey: uniqueId('idem'), settlementGraceSeconds: 60,
    }, afterGrantExpiry))

    const grant = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))
    // 50 - 50 (fully reserved) = 0 remaining; the 30 unused units are forfeited, not returned, since the grant expired mid-reservation.
    expect(grant?.remainingUnits).toBe(0)

    const expireEntries = await db.select().from(billingLedgerEntries)
      .where(eq(billingLedgerEntries.grantId, grantId))
    expect(expireEntries.some((entry) => entry.entryType === 'expire')).toBe(true)
  })

  it('refuses over-settlement (actualUnits exceeding maximumUnits), leaving the reservation untouched', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 100, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 30, maxDurationSeconds: 300,
    }))
    await expect(db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId, actualUnits: 31, idempotencyKey: uniqueId('idem'), settlementGraceSeconds: 60,
    }))).rejects.toThrow(ReservationError)
  })

  it('replays the original settlement for a duplicate idempotency key (crash/retry) instead of double-consuming', async () => {
    const orgId = await freshOrg()
    const grantId = await seedGrant(orgId, 100, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 40, maxDurationSeconds: 300,
    }))
    const settleIdempotencyKey = uniqueId('idem')
    const first = await db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId, actualUnits: 20, idempotencyKey: settleIdempotencyKey, settlementGraceSeconds: 60,
    }))
    const second = await db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId, actualUnits: 20, idempotencyKey: settleIdempotencyKey, settlementGraceSeconds: 60,
    }))
    expect(second.replayed).toBe(true)
    expect(second.reservation.id).toBe(first.reservation.id)

    // A crash/retry must never double-release: settling once should leave exactly the expected balance.
    const grant = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))
    expect(grant?.remainingUnits).toBe(80) // 100 - 40 reserved + 20 released back (40-20 consumed) = 80
  })

  it('refuses to settle a reservation that is no longer reserved', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 50, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 20, maxDurationSeconds: 300,
    }))
    await db.transaction((tx) => releaseReservation(tx, {
      organizationId: orgId, reservationId, idempotencyKey: uniqueId('idem'),
    }))
    await expect(db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId, actualUnits: 5, idempotencyKey: uniqueId('idem'), settlementGraceSeconds: 60,
    }))).rejects.toThrow(ReservationError)
  })
})

describe('releaseReservation', () => {
  it('returns every allocated unit to the source grant when nothing was consumed', async () => {
    const orgId = await freshOrg()
    const grantId = await seedGrant(orgId, 100, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 45, maxDurationSeconds: 300,
    }))
    await db.transaction((tx) => releaseReservation(tx, {
      organizationId: orgId, reservationId, idempotencyKey: uniqueId('idem'),
    }))
    const grant = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))
    expect(grant?.remainingUnits).toBe(100)
  })

  it('replays the original release for a duplicate idempotency key instead of releasing twice', async () => {
    const orgId = await freshOrg()
    const grantId = await seedGrant(orgId, 50, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 20, maxDurationSeconds: 300,
    }))
    const releaseIdempotencyKey = uniqueId('idem')
    const first = await db.transaction((tx) => releaseReservation(tx, {
      organizationId: orgId, reservationId, idempotencyKey: releaseIdempotencyKey,
    }))
    const second = await db.transaction((tx) => releaseReservation(tx, {
      organizationId: orgId, reservationId, idempotencyKey: releaseIdempotencyKey,
    }))
    expect(second.replayed).toBe(true)
    expect(second.reservation.id).toBe(first.reservation.id)

    // A duplicate release call must never double-credit the grant back.
    const grant = await db.transaction((tx) => findCreditGrant(tx, orgId, grantId))
    expect(grant?.remainingUnits).toBe(50)
  })

  it('refuses to release a reservation that is no longer reserved', async () => {
    const orgId = await freshOrg()
    await seedGrant(orgId, 50, FAR_FUTURE())
    const reservationId = uniqueId('reservation')
    await db.transaction((tx) => reserveCredits(tx, {
      reservationId, organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 20, maxDurationSeconds: 300,
    }))
    await db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId, actualUnits: 20, idempotencyKey: uniqueId('idem'), settlementGraceSeconds: 60,
    }))
    await expect(db.transaction((tx) => releaseReservation(tx, {
      organizationId: orgId, reservationId, idempotencyKey: uniqueId('idem'),
    }))).rejects.toThrow(ReservationError)
  })
})

describe('concurrent reservations cannot overspend a shared balance', () => {
  it('when two reservations race for more than the available balance, at most the available total is ever allocated', async () => {
    const orgId = await freshOrg()
    await db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: orgId, source: 'promotional',
      units: 100, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
    }))

    const attempt = (maximumUnits: number) => db.transaction((tx) => reserveCredits(tx, {
      reservationId: uniqueId('reservation'), organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits, maxDurationSeconds: 300,
    })).catch((error: unknown) => error)

    const [first, second] = await Promise.all([attempt(60), attempt(60)])
    const results = [first, second]
    const succeeded = results.filter((result) => !(result instanceof Error))
    const failed = results.filter((result) => result instanceof ReservationError)

    // Row locking serializes the two transactions — exactly one of the two 60-unit requests can
    // succeed against a 100-unit balance (60 + 60 > 100), the other must see insufficient credits.
    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)

    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, orgId))
    const totalRemaining = grants.reduce((sum, grant) => sum + grant.remainingUnits, 0)
    expect(totalRemaining).toBe(40)
  })

  it('two DIFFERENT idempotency-keyed settle calls racing the same reservation cannot jointly over-consume it', async () => {
    // The existing replay tests above only ever race the SAME idempotency key sequentially (a
    // crash/retry). This races two DISTINCT keys concurrently — no replay short-circuit is
    // possible, so the `state !== 'reserved'` guard (whichever settle commits first flips the
    // reservation to `settled`) is what has to hold under genuine concurrency, not just the
    // idempotency lookup.
    const orgId = await freshOrg()
    await db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: orgId, source: 'promotional',
      units: 100, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
    }))
    const { reservation } = await db.transaction((tx) => reserveCredits(tx, {
      reservationId: uniqueId('reservation'), organizationId: orgId, operation: 'ai_task', rateCardVersion: 1,
      idempotencyKey: uniqueId('idem'), maximumUnits: 80, maxDurationSeconds: 300,
    }))

    const attemptSettle = (actualUnits: number) => db.transaction((tx) => settleReservation(tx, {
      organizationId: orgId, reservationId: reservation.id, actualUnits,
      idempotencyKey: uniqueId('idem'), settlementGraceSeconds: 60,
    })).catch((error: unknown) => error)

    const [first, second] = await Promise.all([attemptSettle(80), attemptSettle(80)])
    const results = [first, second]
    const succeeded = results.filter((result) => !(result instanceof Error))
    const failed = results.filter((result) => result instanceof ReservationError)

    // Exactly one settle wins the race; the other must see "no longer reserved" — never both
    // consuming 80 units each (160 total) against an 80-unit reservation.
    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)

    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, orgId))
    const totalRemaining = grants.reduce((sum, grant) => sum + grant.remainingUnits, 0)
    // 100 granted, 80 reserved+consumed by the single winning settle, 20 never reserved at all.
    expect(totalRemaining).toBe(20)
  })
})
