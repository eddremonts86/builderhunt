import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { organizations } from '~/shared/lib/db/schema'
import {
  drainActiveCreditGrants,
  findCreditGrant,
  findCreditGrantByMonthlyWindowKey,
  findLedgerEntryByIdempotencyKey,
  insertCreditGrant,
  insertLedgerEntry,
  listActiveCreditGrantsByEarliestExpiry,
  listExpiredButStillActiveGrants,
  updateCreditGrantState,
} from '~/shared/lib/repositories/billing-ledger'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('billing_ledger')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: 'ledger-org-a', name: 'A', slug: 'ledger-org-a', createdAt: new Date() },
    { id: 'ledger-org-b', name: 'B', slug: 'ledger-org-b', createdAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('billing ledger repository', () => {
  it('finds a grant only within its own organization (A/B isolation)', async () => {
    await db.transaction(async (tx) => {
      await insertCreditGrant(tx, {
        id: 'ledger-grant-a', organizationId: 'ledger-org-a', source: 'promotional',
        originalUnits: 100, remainingUnits: 100, expiresAt: new Date(Date.now() + 86_400_000),
      })
    })

    const foundInOwnOrg = await db.transaction((tx) => findCreditGrant(tx, 'ledger-org-a', 'ledger-grant-a'))
    const foundInOtherOrg = await db.transaction((tx) => findCreditGrant(tx, 'ledger-org-b', 'ledger-grant-a'))
    expect(foundInOwnOrg?.id).toBe('ledger-grant-a')
    expect(foundInOtherOrg).toBeNull()
  })

  it('returns null for a missing grant', async () => {
    const missing = await db.transaction((tx) => findCreditGrant(tx, 'ledger-org-a', 'nonexistent-grant'))
    expect(missing).toBeNull()
  })

  it('lists active grants ordered by earliest expiry first', async () => {
    const now = Date.now()
    await db.transaction(async (tx) => {
      await insertCreditGrant(tx, {
        id: 'ledger-grant-later', organizationId: 'ledger-org-a', source: 'promotional',
        originalUnits: 10, remainingUnits: 10, expiresAt: new Date(now + 30 * 86_400_000),
      })
      await insertCreditGrant(tx, {
        id: 'ledger-grant-sooner', organizationId: 'ledger-org-a', source: 'promotional',
        originalUnits: 10, remainingUnits: 10, expiresAt: new Date(now + 5 * 86_400_000),
      })
    })

    const grants = await db.transaction((tx) => listActiveCreditGrantsByEarliestExpiry(tx, 'ledger-org-a'))
    const ids = grants.map((grant) => grant.id)
    expect(ids.indexOf('ledger-grant-sooner')).toBeLessThan(ids.indexOf('ledger-grant-later'))
  })

  it('excludes non-active grants from the earliest-expiry list', async () => {
    await db.transaction(async (tx) => {
      await insertCreditGrant(tx, {
        id: 'ledger-grant-frozen', organizationId: 'ledger-org-a', source: 'promotional',
        originalUnits: 10, remainingUnits: 10, expiresAt: new Date(Date.now() + 86_400_000),
      })
      await updateCreditGrantState(tx, 'ledger-org-a', 'ledger-grant-frozen', { state: 'frozen', remainingUnits: 10 })
    })

    const grants = await db.transaction((tx) => listActiveCreditGrantsByEarliestExpiry(tx, 'ledger-org-a'))
    expect(grants.map((grant) => grant.id)).not.toContain('ledger-grant-frozen')
  })

  it('finds a grant by its unique monthly window key', async () => {
    await db.transaction((tx) => insertCreditGrant(tx, {
      id: 'ledger-grant-window', organizationId: 'ledger-org-a', source: 'subscription_annual_window',
      monthlyWindowKey: 'sub-1:2026-08', originalUnits: 140, remainingUnits: 140, expiresAt: new Date(Date.now() + 86_400_000),
    }))

    const found = await db.transaction((tx) => findCreditGrantByMonthlyWindowKey(tx, 'ledger-org-a', 'sub-1:2026-08'))
    expect(found?.id).toBe('ledger-grant-window')
  })

  it('rejects a second grant for the same monthly window key (unique constraint)', async () => {
    await expect(db.transaction((tx) => insertCreditGrant(tx, {
      id: 'ledger-grant-window-dup', organizationId: 'ledger-org-a', source: 'subscription_annual_window',
      monthlyWindowKey: 'sub-1:2026-08', originalUnits: 140, remainingUnits: 140, expiresAt: new Date(Date.now() + 86_400_000),
    }))).rejects.toThrow()
  })

  it('finds a ledger entry by its idempotency key, scoped to its own organization', async () => {
    await db.transaction((tx) => insertLedgerEntry(tx, {
      id: 'ledger-entry-idem', organizationId: 'ledger-org-a', entryType: 'grant',
      grantId: 'ledger-grant-a', unitsDelta: 100, sourceIdempotencyKey: 'idem-ledger-entry-1',
    }))

    const foundInOwnOrg = await db.transaction((tx) => findLedgerEntryByIdempotencyKey(tx, 'ledger-org-a', 'idem-ledger-entry-1'))
    const foundInOtherOrg = await db.transaction((tx) => findLedgerEntryByIdempotencyKey(tx, 'ledger-org-b', 'idem-ledger-entry-1'))
    expect(foundInOwnOrg?.id).toBe('ledger-entry-idem')
    expect(foundInOtherOrg).toBeNull()
  })

  it('rejects a second ledger entry with the same idempotency key for the same organization (duplicate keys)', async () => {
    await expect(db.transaction((tx) => insertLedgerEntry(tx, {
      id: 'ledger-entry-idem-dup', organizationId: 'ledger-org-a', entryType: 'adjust',
      grantId: 'ledger-grant-a', unitsDelta: -1, sourceIdempotencyKey: 'idem-ledger-entry-1',
    }))).rejects.toThrow()
  })

  it('lists grants whose expiresAt has already passed but are still marked active', async () => {
    await db.transaction((tx) => insertCreditGrant(tx, {
      id: 'ledger-grant-past-expiry', organizationId: 'ledger-org-a', source: 'promotional',
      originalUnits: 5, remainingUnits: 5, expiresAt: new Date(Date.now() - 86_400_000),
    }))

    const expired = await db.transaction((tx) => listExpiredButStillActiveGrants(tx, 'ledger-org-a', new Date()))
    expect(expired.map((grant) => grant.id)).toContain('ledger-grant-past-expiry')
  })
})

/**
 * The second batch, which is the only place a Date cursor can fail.
 *
 * `activeGrantConditions` binds `after.expiresAt` — a JS `Date` — into a raw `sql` template. That
 * cannot reach the wire: `drizzle(client)` replaces postgres.js's serializers for the date and
 * timestamp OIDs with a pass-through (`postgres-js/driver.js`, the `transparentParser` loop), so the
 * driver hands the `Date` object straight to its byte encoder and Node throws
 * `ERR_INVALID_ARG_TYPE`. Drizzle does that on purpose — it expects values to arrive through column
 * mappers, which stringify — so this is correct usage of the library rather than a bug in it.
 *
 * The first batch passes `after: null`, so nothing binds and everything works. Which is exactly why
 * this went unnoticed: it needs more grants than `CREDIT_GRANT_BATCH` before it can fire, and then
 * it fires on the credit-consumption path.
 */
describe('draining more grants than one batch holds', () => {
  it('crosses the batch boundary instead of throwing on the cursor', async () => {
    const now = Date.now()
    await db.transaction(async (tx) => {
      for (let index = 0; index < 5; index += 1) {
        await insertCreditGrant(tx, {
          id: `ledger-drain-${index}`,
          organizationId: 'ledger-org-b',
          source: 'promotional',
          originalUnits: 10,
          remainingUnits: 10,
          // Distinct expiries, so the cursor is a moving Date rather than one repeated tie.
          expiresAt: new Date(now + (index + 1) * 86_400_000),
        })
      }
    })

    const seen: string[] = []
    // A limit of two over five grants forces three reads, so the cursor is bound twice.
    await db.transaction((tx) => drainActiveCreditGrants(tx, 'ledger-org-b', { limit: 2 }, (batch) => {
      seen.push(...batch.map((grant) => grant.id))
      return true
    }))

    expect(seen).toEqual([
      'ledger-drain-0', 'ledger-drain-1', 'ledger-drain-2', 'ledger-drain-3', 'ledger-drain-4',
    ])
  })
})
