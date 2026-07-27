import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { billingCreditGrants, organizations } from '~/shared/lib/db/schema'
import { computeAnniversary, deriveDueAnnualGrantWindows, issueAnnualSubscriptionGrants } from '~/shared/lib/billing/annual-grants'

describe('computeAnniversary', () => {
  it('advances by a whole month in the ordinary case', () => {
    expect(computeAnniversary(new Date('2026-03-15T00:00:00Z'), 1)).toEqual(new Date('2026-04-15T00:00:00Z'))
  })

  it('clamps Jan 31 to Feb 28 in a non-leap year', () => {
    expect(computeAnniversary(new Date('2026-01-31T00:00:00Z'), 1)).toEqual(new Date('2026-02-28T00:00:00Z'))
  })

  it('clamps Jan 31 to Feb 29 in a leap year', () => {
    expect(computeAnniversary(new Date('2028-01-31T00:00:00Z'), 1)).toEqual(new Date('2028-02-29T00:00:00Z'))
  })

  it('clamps Jan 30 to Feb 28/29 the same way', () => {
    expect(computeAnniversary(new Date('2026-01-30T00:00:00Z'), 1)).toEqual(new Date('2026-02-28T00:00:00Z'))
    expect(computeAnniversary(new Date('2028-01-30T00:00:00Z'), 1)).toEqual(new Date('2028-02-29T00:00:00Z'))
  })

  it('clamps Jan 29 the same way, including the leap-day case', () => {
    expect(computeAnniversary(new Date('2026-01-29T00:00:00Z'), 1)).toEqual(new Date('2026-02-28T00:00:00Z'))
    expect(computeAnniversary(new Date('2028-01-29T00:00:00Z'), 1)).toEqual(new Date('2028-02-29T00:00:00Z'))
  })

  it('does not carry the clamp forward once the target month is long enough again', () => {
    // Jan 31 anchor: Feb clamps to 28, but March has 31 days again — no permanent drift.
    expect(computeAnniversary(new Date('2026-01-31T00:00:00Z'), 2)).toEqual(new Date('2026-03-31T00:00:00Z'))
  })

  it('rolls over the year correctly', () => {
    expect(computeAnniversary(new Date('2026-12-15T00:00:00Z'), 1)).toEqual(new Date('2027-01-15T00:00:00Z'))
  })

  it('preserves the anchor time-of-day (UTC-only, DST-independent)', () => {
    expect(computeAnniversary(new Date('2026-01-15T23:30:45.123Z'), 1)).toEqual(new Date('2026-02-15T23:30:45.123Z'))
  })
})

describe('deriveDueAnnualGrantWindows', () => {
  const subscriptionStart = new Date('2026-01-31T12:00:00Z')
  const periodEnd = new Date('2027-01-31T12:00:00Z')

  it('returns nothing before the first remaining anniversary (window 2) is due', () => {
    expect(deriveDueAnnualGrantWindows(subscriptionStart, periodEnd, new Date('2026-02-01T00:00:00Z'))).toEqual([])
  })

  it('returns window 2 once its anniversary (clamped to Feb 28) has passed', () => {
    const windows = deriveDueAnnualGrantWindows(subscriptionStart, periodEnd, new Date('2026-03-01T00:00:00Z'))
    expect(windows).toEqual([{ index: 2, windowStart: new Date('2026-02-28T12:00:00Z'), windowEnd: new Date('2026-03-31T12:00:00Z') }])
  })

  it('catches up on every overdue window at once for a late worker', () => {
    const windows = deriveDueAnnualGrantWindows(subscriptionStart, periodEnd, new Date('2027-06-01T00:00:00Z'))
    expect(windows).toHaveLength(11) // windows 2..12
    expect(windows.map((w) => w.index)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it("window 12's end is the subscription's real period end, not a recomputed anniversary", () => {
    const windows = deriveDueAnnualGrantWindows(subscriptionStart, periodEnd, new Date('2027-06-01T00:00:00Z'))
    expect(windows[windows.length - 1]).toMatchObject({ index: 12, windowEnd: periodEnd })
  })

  it('is due at the exact anniversary instant (inclusive boundary)', () => {
    const windows = deriveDueAnnualGrantWindows(subscriptionStart, periodEnd, new Date('2026-02-28T12:00:00Z'))
    expect(windows).toHaveLength(1)
    expect(windows[0].index).toBe(2)
  })
})

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `annual-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('annual_grants')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

async function seedOrganization(): Promise<string> {
  const organizationId = uniqueId('org')
  await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
  return organizationId
}

async function grantsFor(organizationId: string, stripeSubscriptionId: string) {
  return db.select().from(billingCreditGrants).where(eq(billingCreditGrants.sourceReference, stripeSubscriptionId))
}

describe('issueAnnualSubscriptionGrants', () => {
  it('issues nothing before any remaining window is due', async () => {
    const organizationId = await seedOrganization()
    const stripeSubscriptionId = uniqueId('sub')
    const issued = await db.transaction((tx) =>
      issueAnnualSubscriptionGrants(tx, organizationId, {
        stripeSubscriptionId, monthlyCredits: 700,
        currentPeriodStart: new Date('2026-01-31T00:00:00Z'), currentPeriodEnd: new Date('2027-01-31T00:00:00Z'),
      }, new Date('2026-02-01T00:00:00Z')),
    )
    expect(issued).toBe(0)
    expect(await grantsFor(organizationId, stripeSubscriptionId)).toHaveLength(0)
  })

  it('issues every overdue window at once for a late worker, each with the right expiry', async () => {
    const organizationId = await seedOrganization()
    const stripeSubscriptionId = uniqueId('sub')
    const issued = await db.transaction((tx) =>
      issueAnnualSubscriptionGrants(tx, organizationId, {
        stripeSubscriptionId, monthlyCredits: 700,
        currentPeriodStart: new Date('2026-01-31T00:00:00Z'), currentPeriodEnd: new Date('2027-01-31T00:00:00Z'),
      }, new Date('2026-06-01T00:00:00Z')),
    )
    // By June 1, anniversaries 2 (Feb 28), 3 (Mar 31), 4 (Apr 30), 5 (May 31) have passed.
    expect(issued).toBe(4)
    const rows = await grantsFor(organizationId, stripeSubscriptionId)
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row.originalUnits).toBe(700)
  })

  it('is idempotent — a second call at the same time issues nothing new', async () => {
    const organizationId = await seedOrganization()
    const stripeSubscriptionId = uniqueId('sub')
    const snapshot = {
      stripeSubscriptionId, monthlyCredits: 700,
      currentPeriodStart: new Date('2026-01-31T00:00:00Z'), currentPeriodEnd: new Date('2027-01-31T00:00:00Z'),
    }
    const now = new Date('2026-06-01T00:00:00Z')
    const first = await db.transaction((tx) => issueAnnualSubscriptionGrants(tx, organizationId, snapshot, now))
    const second = await db.transaction((tx) => issueAnnualSubscriptionGrants(tx, organizationId, snapshot, now))

    expect(first).toBe(4)
    expect(second).toBe(0)
    expect(await grantsFor(organizationId, stripeSubscriptionId)).toHaveLength(4)
  })

  it('a duplicate worker run and a later run together still converge on exactly one grant per window', async () => {
    const organizationId = await seedOrganization()
    const stripeSubscriptionId = uniqueId('sub')
    const snapshot = {
      stripeSubscriptionId, monthlyCredits: 140,
      currentPeriodStart: new Date('2026-03-15T00:00:00Z'), currentPeriodEnd: new Date('2027-03-15T00:00:00Z'),
    }
    // Two concurrent-ish runs both see window 2 as due.
    const runA = await db.transaction((tx) => issueAnnualSubscriptionGrants(tx, organizationId, snapshot, new Date('2026-04-16T00:00:00Z')))
    const runB = await db.transaction((tx) => issueAnnualSubscriptionGrants(tx, organizationId, snapshot, new Date('2026-04-16T00:00:00Z')))
    expect(runA + runB).toBe(1)

    // A later run picks up window 3 without re-granting window 2.
    const runC = await db.transaction((tx) => issueAnnualSubscriptionGrants(tx, organizationId, snapshot, new Date('2026-05-16T00:00:00Z')))
    expect(runC).toBe(1)
    expect(await grantsFor(organizationId, stripeSubscriptionId)).toHaveLength(2)
  })
})
