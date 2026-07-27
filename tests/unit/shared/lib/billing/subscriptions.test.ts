import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { organizationEntitlements, organizations } from '~/shared/lib/db/schema'
import { mapStripeStatusToEntitlementStatus, projectSubscriptionEntitlement, resolveEntitlementProjection } from '~/shared/lib/billing/subscriptions'

describe('mapStripeStatusToEntitlementStatus', () => {
  it('maps active and trialing as-is', () => {
    expect(mapStripeStatusToEntitlementStatus('active')).toBe('active')
    expect(mapStripeStatusToEntitlementStatus('trialing')).toBe('trialing')
  })

  it('maps past_due, unpaid, and paused to past_due', () => {
    expect(mapStripeStatusToEntitlementStatus('past_due')).toBe('past_due')
    expect(mapStripeStatusToEntitlementStatus('unpaid')).toBe('past_due')
    expect(mapStripeStatusToEntitlementStatus('paused')).toBe('past_due')
  })

  it('maps canceled as-is', () => {
    expect(mapStripeStatusToEntitlementStatus('canceled')).toBe('canceled')
  })

  it('returns null for incomplete and incomplete_expired — never a successful initial payment', () => {
    expect(mapStripeStatusToEntitlementStatus('incomplete')).toBeNull()
    expect(mapStripeStatusToEntitlementStatus('incomplete_expired')).toBeNull()
  })

  it('returns null for an unrecognized status', () => {
    expect(mapStripeStatusToEntitlementStatus('something_new')).toBeNull()
  })
})

describe('resolveEntitlementProjection', () => {
  const base = {
    tier: 'pro' as const,
    interval: 'monthly' as const,
    currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    seatLimit: 1,
  }

  it('projects tier/status/period/seatLimit for an active subscription', () => {
    expect(resolveEntitlementProjection({ ...base, stripeStatus: 'active' })).toEqual({
      tier: 'pro',
      status: 'active',
      billingPeriod: 'monthly',
      currentPeriodStart: base.currentPeriodStart,
      currentPeriodEnd: base.currentPeriodEnd,
      seatLimit: 1,
    })
  })

  it('projects pro_max and team tiers unchanged', () => {
    expect(resolveEntitlementProjection({ ...base, tier: 'pro_max', stripeStatus: 'active' })?.tier).toBe('pro_max')
    expect(resolveEntitlementProjection({ ...base, tier: 'team', stripeStatus: 'active' })?.tier).toBe('team')
  })

  it('returns null for a never-paid subscription', () => {
    expect(resolveEntitlementProjection({ ...base, stripeStatus: 'incomplete' })).toBeNull()
    expect(resolveEntitlementProjection({ ...base, stripeStatus: 'incomplete_expired' })).toBeNull()
  })

  it('preserves tier while marking status canceled', () => {
    expect(resolveEntitlementProjection({ ...base, tier: 'team', stripeStatus: 'canceled' })).toMatchObject({ tier: 'team', status: 'canceled' })
  })
})

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `sub-proj-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('subscriptions')
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

async function readEntitlement(organizationId: string) {
  const [row] = await db.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, organizationId)).limit(1)
  return row ?? null
}

describe('projectSubscriptionEntitlement', () => {
  it('inserts a new entitlement row for a first-sighting active subscription', async () => {
    const organizationId = await seedOrganization()
    await db.transaction((tx) =>
      projectSubscriptionEntitlement(tx, organizationId, {
        tier: 'pro',
        stripeStatus: 'active',
        interval: 'monthly',
        currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
        seatLimit: 1,
      }),
    )

    const row = await readEntitlement(organizationId)
    expect(row).toMatchObject({ tier: 'pro', status: 'active', billingPeriod: 'monthly', seatLimit: 1 })
  })

  it('upserts an existing row on renewal without creating a duplicate', async () => {
    const organizationId = await seedOrganization()
    await db.transaction((tx) =>
      projectSubscriptionEntitlement(tx, organizationId, {
        tier: 'pro', stripeStatus: 'active', interval: 'monthly',
        currentPeriodStart: new Date('2026-01-01T00:00:00Z'), currentPeriodEnd: new Date('2026-02-01T00:00:00Z'), seatLimit: 1,
      }),
    )
    await db.transaction((tx) =>
      projectSubscriptionEntitlement(tx, organizationId, {
        tier: 'pro', stripeStatus: 'active', interval: 'monthly',
        currentPeriodStart: new Date('2026-02-01T00:00:00Z'), currentPeriodEnd: new Date('2026-03-01T00:00:00Z'), seatLimit: 1,
      }),
    )

    const row = await readEntitlement(organizationId)
    expect(row?.currentPeriodEnd?.toISOString()).toBe(new Date('2026-03-01T00:00:00Z').toISOString())
  })

  it('writes a pro_max entitlement (requires the widened tier CHECK constraint)', async () => {
    const organizationId = await seedOrganization()
    await db.transaction((tx) =>
      projectSubscriptionEntitlement(tx, organizationId, {
        tier: 'pro_max', stripeStatus: 'active', interval: 'monthly',
        currentPeriodStart: new Date('2026-01-01T00:00:00Z'), currentPeriodEnd: new Date('2026-02-01T00:00:00Z'), seatLimit: 1,
      }),
    )

    const row = await readEntitlement(organizationId)
    expect(row).toMatchObject({ tier: 'pro_max', status: 'active' })
  })

  it('does nothing for an incomplete subscription that never paid — no entitlement row is created', async () => {
    const organizationId = await seedOrganization()
    await db.transaction((tx) =>
      projectSubscriptionEntitlement(tx, organizationId, {
        tier: 'pro', stripeStatus: 'incomplete', interval: 'monthly',
        currentPeriodStart: null, currentPeriodEnd: null, seatLimit: 1,
      }),
    )

    expect(await readEntitlement(organizationId)).toBeNull()
  })

  it('marks status canceled on cancellation while preserving the tier', async () => {
    const organizationId = await seedOrganization()
    await db.transaction((tx) =>
      projectSubscriptionEntitlement(tx, organizationId, {
        tier: 'team', stripeStatus: 'active', interval: 'annual',
        currentPeriodStart: new Date('2026-01-01T00:00:00Z'), currentPeriodEnd: new Date('2027-01-01T00:00:00Z'), seatLimit: 10,
      }),
    )
    await db.transaction((tx) =>
      projectSubscriptionEntitlement(tx, organizationId, {
        tier: 'team', stripeStatus: 'canceled', interval: 'annual',
        currentPeriodStart: new Date('2026-01-01T00:00:00Z'), currentPeriodEnd: new Date('2027-01-01T00:00:00Z'), seatLimit: 10,
      }),
    )

    const row = await readEntitlement(organizationId)
    expect(row).toMatchObject({ tier: 'team', status: 'canceled' })
  })
})
