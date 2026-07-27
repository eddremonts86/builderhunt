import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { billingCustomers, billingSubscriptions, organizations } from '~/shared/lib/db/schema'
import { FakeBillingProvider } from '~/shared/lib/billing/fake-provider'
import { applyDuePriceMigration, resolvePriceMigration, type PriceMigrationCandidate, type PriceMigrationTarget } from '~/shared/lib/billing/price-migrations'

function candidate(overrides: Partial<PriceMigrationCandidate> = {}): PriceMigrationCandidate {
  return {
    contractedVersion: 1,
    contractedAmountCents: 1900,
    currentVersion: 2,
    currentAmountCents: 2400,
    priceEffectiveAt: new Date('2026-01-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-01-15T00:00:00Z'),
    ...overrides,
  }
}

describe('resolvePriceMigration', () => {
  it('is up to date when the contracted and current versions already match', () => {
    const result = resolvePriceMigration(candidate({ contractedVersion: 2, currentVersion: 2 }), new Date('2026-06-01T00:00:00Z'))
    expect(result).toEqual({ migrate: false, reason: 'up_to_date' })
  })

  it('withholds a price INCREASE until the 30-day notice has elapsed, even past the renewal date', () => {
    const result = resolvePriceMigration(
      candidate({ priceEffectiveAt: new Date('2026-01-01T00:00:00Z'), currentPeriodEnd: new Date('2026-01-05T00:00:00Z') }),
      new Date('2026-01-20T00:00:00Z'), // past period end, but only 19 days of notice
    )
    expect(result).toEqual({ migrate: false, reason: 'notice_period_not_elapsed' })
  })

  it('migrates an increase once notice has elapsed AND the period has ended', () => {
    const result = resolvePriceMigration(
      candidate({ priceEffectiveAt: new Date('2026-01-01T00:00:00Z'), currentPeriodEnd: new Date('2026-01-05T00:00:00Z') }),
      new Date('2026-02-01T00:00:00Z'), // 31 days of notice, well past period end
    )
    expect(result).toEqual({ migrate: true, reason: 'due_at_renewal', newVersion: 2, newAmountCents: 2400 })
  })

  it('is exactly at the 30-day notice boundary — not yet elapsed at the instant, elapsed one second later', () => {
    const priceEffectiveAt = new Date('2026-01-01T00:00:00Z')
    const noticeEndsAt = new Date(priceEffectiveAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    const c = candidate({ priceEffectiveAt, currentPeriodEnd: new Date('2025-12-01T00:00:00Z') }) // period already over

    expect(resolvePriceMigration(c, noticeEndsAt).migrate).toBe(true) // inclusive boundary
    expect(resolvePriceMigration(c, new Date(noticeEndsAt.getTime() - 1000)).migrate).toBe(false)
  })

  it('requires no notice period for a price DECREASE, but still waits for the renewal boundary', () => {
    const c = candidate({ contractedAmountCents: 2400, currentAmountCents: 1900, priceEffectiveAt: new Date('2026-01-01T00:00:00Z') })

    // The very next instant after the price dropped, but before the current period has ended.
    expect(resolvePriceMigration({ ...c, currentPeriodEnd: new Date('2026-02-01T00:00:00Z') }, new Date('2026-01-01T00:00:01Z')))
      .toEqual({ migrate: false, reason: 'before_renewal' })

    // Past the period end — migrates immediately, no notice required for a decrease.
    expect(resolvePriceMigration({ ...c, currentPeriodEnd: new Date('2026-01-02T00:00:00Z') }, new Date('2026-01-03T00:00:00Z')).migrate)
      .toBe(true)
  })

  it('never migrates before the subscriber\'s own current period has ended, preserving the paid term (monthly or annual alike)', () => {
    const result = resolvePriceMigration(
      candidate({ priceEffectiveAt: new Date('2025-01-01T00:00:00Z'), currentPeriodEnd: new Date('2027-01-01T00:00:00Z') }), // annual term, notice long elapsed
      new Date('2026-06-01T00:00:00Z'), // mid-year — notice elapsed, but the annual term isn't over
    )
    expect(result).toEqual({ migrate: false, reason: 'before_renewal' })
  })

  it('is at the exact renewal-boundary instant — inclusive', () => {
    const periodEnd = new Date('2026-01-05T00:00:00Z')
    const result = resolvePriceMigration(candidate({ priceEffectiveAt: new Date('2025-01-01T00:00:00Z'), currentPeriodEnd: periodEnd }), periodEnd)
    expect(result.migrate).toBe(true)
  })
})

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `pricemig-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('price_migrations')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

async function seedSubscription(catalogVersion: number): Promise<{ organizationId: string; stripeSubscriptionId: string }> {
  const organizationId = uniqueId('org')
  await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
  const customerId = uniqueId('cust')
  await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
  const stripeSubscriptionId = `sub_${uniqueId('sub')}`
  await db.insert(billingSubscriptions).values({
    id: uniqueId('subrow'), organizationId, customerId, livemode: false,
    catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion,
    stripeSubscriptionId, stripeStatus: 'active',
    currentPeriodStart: new Date('2026-01-01T00:00:00Z'), currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    providerSyncedAt: new Date('2026-01-01T00:00:00Z'),
  })
  return { organizationId, stripeSubscriptionId }
}

const TARGET: PriceMigrationTarget = { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', version: 2, priceId: 'price_pro_monthly_v2' }

describe('applyDuePriceMigration', () => {
  it('does nothing when the decision says not to migrate', async () => {
    const provider = new FakeBillingProvider()
    const { organizationId, stripeSubscriptionId } = await seedSubscription(1)
    const applied = await db.transaction((tx) =>
      applyDuePriceMigration(tx, organizationId, { stripeSubscriptionId }, { migrate: false, reason: 'before_renewal' }, TARGET, provider),
    )
    expect(applied).toBe(false)
  })

  it('applies a due migration: swaps the provider price and updates the subscription row', async () => {
    const provider = new FakeBillingProvider()
    const { organizationId, stripeSubscriptionId } = await seedSubscription(1)
    const decision = { migrate: true, reason: 'due_at_renewal' as const, newVersion: 2, newAmountCents: 2400 }

    const applied = await db.transaction((tx) =>
      applyDuePriceMigration(tx, organizationId, { stripeSubscriptionId }, decision, TARGET, provider),
    )

    expect(applied).toBe(true)
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
    expect(row.catalogVersion).toBe(2)
    expect(row.catalogKey).toBe('pro_monthly')
  })

  it('a duplicate application (a retried or overlapping worker run) is a no-op — never calls the provider twice', async () => {
    const provider = new FakeBillingProvider()
    const changeSpy = vi.spyOn(provider, 'changeSubscription')
    const { organizationId, stripeSubscriptionId } = await seedSubscription(1)
    const decision = { migrate: true, reason: 'due_at_renewal' as const, newVersion: 2, newAmountCents: 2400 }

    const first = await db.transaction((tx) => applyDuePriceMigration(tx, organizationId, { stripeSubscriptionId }, decision, TARGET, provider))
    // Second call still reports the ORIGINAL (now-stale) `catalogVersion: 1` — as a real worker
    // sweep would if it read the subscription before the first run committed, or is simply run
    // again without re-reading — proving the no-op guard itself, not just a fresh read, is what
    // prevents the duplicate.
    const second = await db.transaction((tx) => applyDuePriceMigration(tx, organizationId, { stripeSubscriptionId }, decision, TARGET, provider))

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(changeSpy).toHaveBeenCalledTimes(1)
  })
})
