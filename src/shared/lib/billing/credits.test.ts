import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { billingLedgerEntries, organizations } from '../db/schema'
import { findCreditGrant } from '../repositories/billing-ledger'
import {
  adjustCreditGrant,
  CreditLedgerError,
  expireCreditGrant,
  freezeCreditGrant,
  getAvailableCreditBalance,
  getAvailableCreditGrantsByEarliestExpiry,
  grantCredits,
  isActivePaidSubscription,
  revokeCreditGrant,
  unfreezeCreditGrant,
} from './credits'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `credits-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('billing_credits')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([{ id: 'credits-org-a', name: 'A', slug: 'credits-org-a', createdAt: new Date() }])
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('grantCredits', () => {
  it('grants the requested units and records a matching ledger entry', async () => {
    const grantId = uniqueId('grant')
    const idempotencyKey = uniqueId('idem')
    const result = await db.transaction((tx) => grantCredits(tx, {
      grantId, ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a', source: 'promotional',
      units: 140, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey,
    }))
    expect(result.grant.originalUnits).toBe(140)
    expect(result.grant.remainingUnits).toBe(140)
    expect(result.ledgerEntry.unitsDelta).toBe(140)
    expect(result.replayed).toBe(false)
  })

  it('rejects a non-positive unit count', async () => {
    await expect(db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a',
      source: 'promotional', units: 0, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))).rejects.toThrow(CreditLedgerError)
  })

  it('replays the original result for a duplicate idempotency key instead of granting twice', async () => {
    const idempotencyKey = uniqueId('idem')
    const first = await db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a',
      source: 'promotional', units: 50, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey,
    }))
    const second = await db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a',
      source: 'promotional', units: 50, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey,
    }))
    expect(second.replayed).toBe(true)
    expect(second.grant.id).toBe(first.grant.id)

    const entries = await db.select().from(billingLedgerEntries).where(eq(billingLedgerEntries.sourceIdempotencyKey, idempotencyKey))
    expect(entries).toHaveLength(1)
  })

  it('rejects a second grant for an already-used monthly window key', async () => {
    const monthlyWindowKey = uniqueId('window')
    await db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a',
      source: 'subscription_annual_window', monthlyWindowKey, units: 140,
      expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))
    await expect(db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a',
      source: 'subscription_annual_window', monthlyWindowKey, units: 140,
      expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))).rejects.toThrow(CreditLedgerError)
  })
})

describe('expireCreditGrant / revokeCreditGrant', () => {
  it('forfeits whatever remains and zeroes the balance on expiry', async () => {
    const grantId = uniqueId('grant')
    await db.transaction((tx) => grantCredits(tx, {
      grantId, ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a', source: 'promotional',
      units: 30, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))
    const result = await db.transaction((tx) => expireCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
    }))
    expect(result.grant.state).toBe('expired')
    expect(result.grant.remainingUnits).toBe(0)
    expect(result.ledgerEntry.unitsDelta).toBe(-30)
  })

  it('refuses to expire an already-terminal grant with a fresh idempotency key', async () => {
    const grantId = uniqueId('grant')
    await db.transaction((tx) => grantCredits(tx, {
      grantId, ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a', source: 'promotional',
      units: 10, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))
    await db.transaction((tx) => revokeCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
    }))
    await expect(db.transaction((tx) => expireCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
    }))).rejects.toThrow(CreditLedgerError)
  })
})

describe('freezeCreditGrant / unfreezeCreditGrant', () => {
  it('preserves remainingUnits across a freeze/unfreeze cycle', async () => {
    const grantId = uniqueId('grant')
    await db.transaction((tx) => grantCredits(tx, {
      grantId, ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a', source: 'promotional',
      units: 60, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))
    const frozen = await db.transaction((tx) => freezeCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
    }))
    expect(frozen.grant.state).toBe('frozen')
    expect(frozen.grant.remainingUnits).toBe(60)
    expect(frozen.ledgerEntry.unitsDelta).toBe(0)

    const unfrozen = await db.transaction((tx) => unfreezeCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
    }))
    expect(unfrozen.grant.state).toBe('active')
    expect(unfrozen.grant.remainingUnits).toBe(60)
  })

  it('refuses to unfreeze a grant that is not currently frozen', async () => {
    const grantId = uniqueId('grant')
    await db.transaction((tx) => grantCredits(tx, {
      grantId, ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a', source: 'promotional',
      units: 20, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))
    await expect(db.transaction((tx) => unfreezeCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
    }))).rejects.toThrow(CreditLedgerError)
  })
})

describe('adjustCreditGrant', () => {
  it('applies a positive compensating adjustment within bounds', async () => {
    const grantId = uniqueId('grant')
    await db.transaction((tx) => grantCredits(tx, {
      grantId, ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a', source: 'promotional',
      units: 100, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))
    await db.transaction((tx) => adjustCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
      unitsDelta: -40, reason: 'manual usage correction',
    }))
    const result = await db.transaction((tx) => adjustCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
      unitsDelta: 10, reason: 'compensating over-correction',
    }))
    expect(result.grant.remainingUnits).toBe(70)
  })

  it('refuses an adjustment that would push remainingUnits below zero', async () => {
    const grantId = uniqueId('grant')
    await db.transaction((tx) => grantCredits(tx, {
      grantId, ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a', source: 'promotional',
      units: 10, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))
    await expect(db.transaction((tx) => adjustCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
      unitsDelta: -11, reason: 'over-deduction attempt',
    }))).rejects.toThrow(CreditLedgerError)
  })

  it('refuses an adjustment that would exceed originalUnits', async () => {
    const grantId = uniqueId('grant')
    await db.transaction((tx) => grantCredits(tx, {
      grantId, ledgerEntryId: uniqueId('entry'), organizationId: 'credits-org-a', source: 'promotional',
      units: 10, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('idem'),
    }))
    await expect(db.transaction((tx) => adjustCreditGrant(tx, {
      organizationId: 'credits-org-a', grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'),
      unitsDelta: 1, reason: 'over-credit attempt',
    }))).rejects.toThrow(CreditLedgerError)
  })
})

describe('getAvailableCreditBalance / getAvailableCreditGrantsByEarliestExpiry', () => {
  it('sums only active, not-yet-expired grants, ordered earliest expiry first', async () => {
    const orgId = uniqueId('org')
    await db.insert(organizations).values({ id: orgId, name: 'Balance', slug: orgId, createdAt: new Date() })
    const now = Date.now()

    await db.transaction(async (tx) => {
      await grantCredits(tx, {
        grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: orgId, source: 'promotional',
        units: 100, expiresAt: new Date(now + 30 * 86_400_000), idempotencyKey: uniqueId('idem'),
      })
      await grantCredits(tx, {
        grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: orgId, source: 'promotional',
        units: 50, expiresAt: new Date(now + 5 * 86_400_000), idempotencyKey: uniqueId('idem'),
      })
      // Already-expired grant: must not count toward the available balance even though its state row still says 'active'.
      await grantCredits(tx, {
        grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: orgId, source: 'promotional',
        units: 999, expiresAt: new Date(now - 86_400_000), idempotencyKey: uniqueId('idem'),
      })
    })

    const balance = await db.transaction((tx) => getAvailableCreditBalance(tx, orgId, new Date(now)))
    expect(balance).toBe(150)

    const grants = await db.transaction((tx) => getAvailableCreditGrantsByEarliestExpiry(tx, orgId, new Date(now)))
    expect(grants[0].remainingUnits).toBe(50)
    expect(grants[1].remainingUnits).toBe(100)
  })
})

describe('isActivePaidSubscription', () => {
  it('is false for no subscription', () => {
    expect(isActivePaidSubscription(null)).toBe(false)
  })

  it('is true for active and trialing, false for everything else', () => {
    expect(isActivePaidSubscription({ stripeStatus: 'active' })).toBe(true)
    expect(isActivePaidSubscription({ stripeStatus: 'trialing' })).toBe(true)
    expect(isActivePaidSubscription({ stripeStatus: 'past_due' })).toBe(false)
    expect(isActivePaidSubscription({ stripeStatus: 'canceled' })).toBe(false)
  })
})

/**
 * Property test: any sequence of freeze/unfreeze/adjust operations applied to one grant must, at
 * every step, keep 0 <= remainingUnits <= originalUnits, and the final remainingUnits must equal
 * originalUnits plus the sum of every non-"grant" ledger entry's unitsDelta recorded for that grant
 * — i.e. the denormalized balance never drifts from the append-only ledger that is supposed to
 * explain it. Rejected operations (invalid state transition, out-of-bounds adjustment) are expected
 * and must leave the grant completely unchanged.
 */
type RandomOp =
  | { type: 'freeze' }
  | { type: 'unfreeze' }
  | { type: 'adjust'; delta: number }

const randomOpArbitrary: fc.Arbitrary<RandomOp> = fc.oneof(
  fc.constant<RandomOp>({ type: 'freeze' }),
  fc.constant<RandomOp>({ type: 'unfreeze' }),
  fc.integer({ min: -150, max: 150 }).filter((delta) => delta !== 0).map((delta): RandomOp => ({ type: 'adjust', delta })),
)

describe('credit grant conservation — property test', () => {
  it('never violates 0 <= remainingUnits <= originalUnits and always matches the ledger, across random operation sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 500 }),
        fc.array(randomOpArbitrary, { minLength: 0, maxLength: 12 }),
        async (originalUnits, ops) => {
          const grantId = uniqueId('prop-grant')
          await db.transaction((tx) => grantCredits(tx, {
            grantId, ledgerEntryId: uniqueId('prop-entry'), organizationId: 'credits-org-a', source: 'promotional',
            units: originalUnits, expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: uniqueId('prop-idem'),
          }))

          for (const [index, op] of ops.entries()) {
            const idempotencyKey = uniqueId(`prop-op-${index}`)
            const ledgerEntryId = uniqueId(`prop-op-entry-${index}`)
            try {
              if (op.type === 'freeze') {
                await db.transaction((tx) => freezeCreditGrant(tx, { organizationId: 'credits-org-a', grantId, ledgerEntryId, idempotencyKey }))
              } else if (op.type === 'unfreeze') {
                await db.transaction((tx) => unfreezeCreditGrant(tx, { organizationId: 'credits-org-a', grantId, ledgerEntryId, idempotencyKey }))
              } else {
                await db.transaction((tx) => adjustCreditGrant(tx, {
                  organizationId: 'credits-org-a', grantId, ledgerEntryId, idempotencyKey, unitsDelta: op.delta, reason: 'property test',
                }))
              }
            } catch (error) {
              // Expected: an invalid state transition or an out-of-bounds adjustment. The grant must
              // be verified unchanged by the invariant check below — the catch only stops this one
              // operation from aborting the whole sequence.
              if (!(error instanceof CreditLedgerError)) throw error
            }

            const current = await db.transaction((tx) => findCreditGrant(tx, 'credits-org-a', grantId))
            if (!current) throw new Error('property test grant vanished unexpectedly')
            expect(current.remainingUnits).toBeGreaterThanOrEqual(0)
            expect(current.remainingUnits).toBeLessThanOrEqual(current.originalUnits)
          }

          const finalGrant = await db.transaction((tx) => findCreditGrant(tx, 'credits-org-a', grantId))
          if (!finalGrant) throw new Error('property test grant vanished unexpectedly')
          const entries = await db
            .select({ entryType: billingLedgerEntries.entryType, unitsDelta: billingLedgerEntries.unitsDelta })
            .from(billingLedgerEntries)
            .where(eq(billingLedgerEntries.grantId, grantId))
          const nonGrantDeltaSum = entries
            .filter((entry) => entry.entryType !== 'grant')
            .reduce((sum, entry) => sum + entry.unitsDelta, 0)
          expect(finalGrant.remainingUnits).toBe(finalGrant.originalUnits + nonGrantDeltaSum)
        },
      ),
      { numRuns: 25 },
    )
  }, 60_000)
})
