import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingCreditGrants, billingCustomers, billingSubscriptions, organizationMembers, organizations } from '../db/schema'
import { SUBSCRIPTION_CATALOG } from './catalog'
import { BillingProviderError, type ChangeSubscriptionInput as ProviderChangeSubscriptionInput } from './provider'
import { FakeBillingProvider } from './fake-provider'

// `getSeatUsage` (organizations/contracts.ts) reads through its own hardcoded `authDb` singleton —
// a separate database connection from this file's disposable test database, with no injection seam
// — so seeding `organizationMembers`/`organizationInvitations` rows here would never be visible to
// it. The seat-blocker tests below control its result directly instead; every other test in this
// file relies on the default (plenty of room) set in `beforeEach`, matching how those tests already
// behaved before the seat-blocker check existed.
const mocks = vi.hoisted(() => ({ getSeatUsage: vi.fn() }))
vi.mock('../organizations/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../organizations/contracts')>()
  return { ...actual, getSeatUsage: mocks.getSeatUsage }
})

import {
  cancelSubscriptionAtPeriodEnd,
  changeSubscription,
  classifySubscriptionChange,
  computeUpgradeCreditDelta,
  previewSubscriptionChange,
  resolveCurrentCreditWindow,
} from './subscription-changes'

describe('classifySubscriptionChange', () => {
  it('classifies a same-interval tier upgrade as immediate', () => {
    expect(classifySubscriptionChange({ tier: 'pro', interval: 'monthly' }, { tier: 'pro_max', interval: 'monthly' })).toEqual({ direction: 'upgrade', timing: 'immediate' })
    expect(classifySubscriptionChange({ tier: 'pro', interval: 'monthly' }, { tier: 'team', interval: 'monthly' })).toEqual({ direction: 'upgrade', timing: 'immediate' })
    expect(classifySubscriptionChange({ tier: 'pro_max', interval: 'annual' }, { tier: 'team', interval: 'annual' })).toEqual({ direction: 'upgrade', timing: 'immediate' })
  })

  it('classifies a same-interval tier downgrade as scheduled', () => {
    expect(classifySubscriptionChange({ tier: 'team', interval: 'monthly' }, { tier: 'pro', interval: 'monthly' })).toEqual({ direction: 'downgrade', timing: 'scheduled' })
    expect(classifySubscriptionChange({ tier: 'pro_max', interval: 'annual' }, { tier: 'pro', interval: 'annual' })).toEqual({ direction: 'downgrade', timing: 'scheduled' })
  })

  it('classifies monthly-to-annual at the same tier as immediate', () => {
    for (const tier of ['pro', 'pro_max', 'team'] as const) {
      expect(classifySubscriptionChange({ tier, interval: 'monthly' }, { tier, interval: 'annual' })).toEqual({ direction: 'upgrade', timing: 'immediate' })
    }
  })

  it('classifies annual-to-monthly at the same tier as scheduled', () => {
    for (const tier of ['pro', 'pro_max', 'team'] as const) {
      expect(classifySubscriptionChange({ tier, interval: 'annual' }, { tier, interval: 'monthly' })).toEqual({ direction: 'downgrade', timing: 'scheduled' })
    }
  })

  it('classifies no change as lateral/immediate', () => {
    expect(classifySubscriptionChange({ tier: 'pro', interval: 'monthly' }, { tier: 'pro', interval: 'monthly' })).toEqual({ direction: 'lateral', timing: 'immediate' })
  })

  it('conservatively schedules a simultaneous tier-and-interval change (not enumerated by spec.md)', () => {
    // Upgrade tier AND switch annual -> monthly at once.
    expect(classifySubscriptionChange({ tier: 'pro', interval: 'annual' }, { tier: 'team', interval: 'monthly' })).toEqual({ direction: 'upgrade', timing: 'scheduled' })
    // Downgrade tier AND switch monthly -> annual at once.
    expect(classifySubscriptionChange({ tier: 'team', interval: 'monthly' }, { tier: 'pro', interval: 'annual' })).toEqual({ direction: 'downgrade', timing: 'scheduled' })
  })

  it('covers every tier/interval pair without throwing (the full matrix)', () => {
    const tiers = ['pro', 'pro_max', 'team'] as const
    const intervals = ['monthly', 'annual'] as const
    for (const currentTier of tiers) {
      for (const currentInterval of intervals) {
        for (const nextTier of tiers) {
          for (const nextInterval of intervals) {
            const result = classifySubscriptionChange({ tier: currentTier, interval: currentInterval }, { tier: nextTier, interval: nextInterval })
            expect(['upgrade', 'downgrade', 'lateral']).toContain(result.direction)
            expect(['immediate', 'scheduled']).toContain(result.timing)
          }
        }
      }
    }
  })
})

describe('resolveCurrentCreditWindow', () => {
  it('for a monthly subscription, the window is the full current period', () => {
    const currentPeriodStart = new Date('2026-03-01T00:00:00Z')
    const currentPeriodEnd = new Date('2026-04-01T00:00:00Z')
    expect(resolveCurrentCreditWindow({ interval: 'monthly', currentPeriodStart, currentPeriodEnd }, new Date('2026-03-15T00:00:00Z')))
      .toEqual({ windowStart: currentPeriodStart, windowEnd: currentPeriodEnd })
  })

  it('for an annual subscription, resolves the specific monthly anniversary window `now` falls in', () => {
    const currentPeriodStart = new Date('2026-01-31T00:00:00Z')
    const currentPeriodEnd = new Date('2027-01-31T00:00:00Z')
    // April 10 falls in window 4: [Mar 31, Apr 30).
    const window = resolveCurrentCreditWindow({ interval: 'annual', currentPeriodStart, currentPeriodEnd }, new Date('2026-04-10T00:00:00Z'))
    expect(window).toEqual({ windowStart: new Date('2026-03-31T00:00:00Z'), windowEnd: new Date('2026-04-30T00:00:00Z') })
  })

  it('for an annual subscription, the FIRST window is the subscription start itself', () => {
    const currentPeriodStart = new Date('2026-01-31T00:00:00Z')
    const currentPeriodEnd = new Date('2027-01-31T00:00:00Z')
    const window = resolveCurrentCreditWindow({ interval: 'annual', currentPeriodStart, currentPeriodEnd }, new Date('2026-02-01T00:00:00Z'))
    expect(window).toEqual({ windowStart: currentPeriodStart, windowEnd: new Date('2026-02-28T00:00:00Z') })
  })

  it('for an annual subscription, the LAST window ends at the real period end, not a recomputed anniversary', () => {
    const currentPeriodStart = new Date('2026-01-31T00:00:00Z')
    const currentPeriodEnd = new Date('2027-01-31T00:00:00Z')
    const window = resolveCurrentCreditWindow({ interval: 'annual', currentPeriodStart, currentPeriodEnd }, new Date('2027-01-15T00:00:00Z'))
    expect(window.windowEnd).toEqual(currentPeriodEnd)
  })
})

describe('computeUpgradeCreditDelta', () => {
  it('applies the ceiling formula from spec.md: ceil((new - old) * remaining / window)', () => {
    const windowStart = new Date('2026-03-01T00:00:00Z')
    const windowEnd = new Date('2026-04-01T00:00:00Z') // 31 days = 2,678,400 seconds
    const now = new Date('2026-03-16T00:00:00Z') // 16 days remaining (Mar 16 -> Apr 1) = 1,382,400 seconds
    const delta = computeUpgradeCreditDelta({ oldMonthlyCredits: 140, newMonthlyCredits: 700, window: { windowStart, windowEnd }, now })
    // (700-140) * 1382400 / 2678400 = 560 * 0.51612... = 289.09... -> ceil = 290
    expect(delta).toBe(290)
  })

  it('is zero when the new allowance is not greater than the old one', () => {
    const window = { windowStart: new Date('2026-03-01T00:00:00Z'), windowEnd: new Date('2026-04-01T00:00:00Z') }
    expect(computeUpgradeCreditDelta({ oldMonthlyCredits: 700, newMonthlyCredits: 140, window, now: new Date('2026-03-16T00:00:00Z') })).toBe(0)
    expect(computeUpgradeCreditDelta({ oldMonthlyCredits: 140, newMonthlyCredits: 140, window, now: new Date('2026-03-16T00:00:00Z') })).toBe(0)
  })

  it('is zero once the window has already ended', () => {
    const window = { windowStart: new Date('2026-03-01T00:00:00Z'), windowEnd: new Date('2026-04-01T00:00:00Z') }
    expect(computeUpgradeCreditDelta({ oldMonthlyCredits: 140, newMonthlyCredits: 700, window, now: new Date('2026-05-01T00:00:00Z') })).toBe(0)
  })

  it('equals the full allowance delta when applied at the very start of the window', () => {
    const window = { windowStart: new Date('2026-03-01T00:00:00Z'), windowEnd: new Date('2026-04-01T00:00:00Z') }
    expect(computeUpgradeCreditDelta({ oldMonthlyCredits: 140, newMonthlyCredits: 700, window, now: window.windowStart })).toBe(560)
  })
})

// ---------------------------------------------------------------------------
// Integration tests: previewSubscriptionChange / changeSubscription against a
// real disposable database and the FakeBillingProvider.
// ---------------------------------------------------------------------------

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `subchange-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('subscription_changes')
  db = disposable.db
  drop = disposable.drop
})

beforeEach(() => {
  mocks.getSeatUsage.mockReset()
  mocks.getSeatUsage.mockResolvedValue({ used: 1, limit: 10 }) // plenty of room by default
})

afterAll(async () => {
  await drop()
})

async function freshOrgWithOwner(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizationMembers).values({ id: uniqueId('member'), organizationId: orgId, userId, role: 'owner', createdAt: new Date() })
  return { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

/** Seeds both our own DB row AND the fake provider's in-memory subscription (under the same id) — `previewSubscriptionChange`/`changeSubscription` read our DB row for plan state, but every provider call still needs the provider to already know this subscription exists. */
async function seedActiveSubscription(
  organizationId: string,
  provider: FakeBillingProvider,
  overrides: Partial<{ catalogKey: string; tier: 'pro' | 'pro_max' | 'team'; interval: 'monthly' | 'annual'; currentPeriodStart: Date; currentPeriodEnd: Date; providerSyncedAt: Date }> = {},
): Promise<string> {
  const customerId = uniqueId('cust')
  const stripeSubscriptionId = `sub_${uniqueId('sub')}`
  const catalogKey = overrides.catalogKey ?? 'pro_monthly'
  await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
  await db.insert(billingSubscriptions).values({
    id: uniqueId('subrow'), organizationId, customerId, livemode: false,
    catalogKey, tier: overrides.tier ?? 'pro', interval: overrides.interval ?? 'monthly', catalogVersion: 1,
    stripeSubscriptionId, stripeStatus: 'active',
    currentPeriodStart: overrides.currentPeriodStart ?? new Date('2026-03-01T00:00:00Z'),
    currentPeriodEnd: overrides.currentPeriodEnd ?? new Date('2026-04-01T00:00:00Z'),
    providerSyncedAt: overrides.providerSyncedAt ?? new Date('2026-03-01T00:00:00Z'),
  })
  await provider.changeSubscription({
    subscriptionId: stripeSubscriptionId,
    newPriceId: SUBSCRIPTION_CATALOG[catalogKey as keyof typeof SUBSCRIPTION_CATALOG].stripePriceId.test ?? 'price_seed',
    idempotencyKey: uniqueId('seed-provider'),
  })
  return stripeSubscriptionId
}

async function readSubscription(stripeSubscriptionId: string) {
  const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
  return row
}

/** Forces `changeSubscription` to throw as if the card were declined — nothing is created or applied. */
class DecliningProvider extends FakeBillingProvider {
  override async changeSubscription(_input: ProviderChangeSubscriptionInput): ReturnType<FakeBillingProvider['changeSubscription']> {
    throw new BillingProviderError('Your card was declined.', 'decline')
  }
}

/** Forces `changeSubscription` to come back requiring further customer action (3DS/SCA) — never silently succeeds. */
class ScaRequiredProvider extends FakeBillingProvider {
  override async changeSubscription(input: ProviderChangeSubscriptionInput): ReturnType<FakeBillingProvider['changeSubscription']> {
    return super.changeSubscription({ ...input, scenario: 'sca_required' })
  }
}

describe('previewSubscriptionChange', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  it('previews an upgrade as immediate with a positive credit delta', async () => {
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })

    const preview = await db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_max_monthly' }, { provider, now: () => new Date('2026-03-16T00:00:00Z') }))

    expect(preview.direction).toBe('upgrade')
    expect(preview.timing).toBe('immediate')
    expect(preview.creditDelta).toBeGreaterThan(0)
  })

  it('previews monthly-to-annual at the same tier as immediate with zero credit delta', async () => {
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })

    const preview = await db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_annual' }, { provider }))

    expect(preview.direction).toBe('upgrade')
    expect(preview.timing).toBe('immediate')
    expect(preview.creditDelta).toBe(0)
  })

  it('previews a downgrade as scheduled for the current period end', async () => {
    const principal = await freshOrgWithOwner()
    const periodEnd = new Date('2026-04-01T00:00:00Z')
    await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly', currentPeriodEnd: periodEnd })

    const preview = await db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_monthly' }, { provider }))

    expect(preview.timing).toBe('scheduled')
    expect(preview.creditDelta).toBe(0)
    expect(preview.effectiveAt).toBe(periodEnd.toISOString())
  })

  it('rejects an unknown catalog key', async () => {
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider)
    await expect(db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'not_a_real_key' }, { provider })))
      .rejects.toMatchObject({ code: 'unknown_catalog_key' })
  })

  it('rejects when there is no active subscription', async () => {
    const principal = await freshOrgWithOwner()
    await expect(db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_monthly' }, { provider })))
      .rejects.toMatchObject({ code: 'no_active_subscription' })
  })

  it('surfaces a seat blocker proactively when active members exceed the target one-seat tier', async () => {
    mocks.getSeatUsage.mockResolvedValue({ used: 3, limit: 10 }) // 3 accepted members, Team's limit
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly' })

    const preview = await db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_monthly' }, { provider }))

    expect(preview.timing).toBe('scheduled')
    expect(preview.seatBlocker).toEqual({ currentSeatsUsed: 3, targetSeatLimit: 1, manageTeamUrl: '/settings/team' })
  })

  it('counts a usable (pending) invitation the same as an accepted member toward the blocker', async () => {
    mocks.getSeatUsage.mockResolvedValue({ used: 2, limit: 10 }) // 1 accepted member + 1 pending invitation
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly' })

    const preview = await db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_monthly' }, { provider }))

    expect(preview.seatBlocker).toMatchObject({ currentSeatsUsed: 2, targetSeatLimit: 1 })
  })

  it('shows no blocker when exactly at the target seat limit', async () => {
    mocks.getSeatUsage.mockResolvedValue({ used: 1, limit: 10 }) // exactly one seat in use
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly' })

    const preview = await db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_monthly' }, { provider }))

    expect(preview.seatBlocker).toBeUndefined()
  })
})

describe('changeSubscription', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  async function previewAndFingerprint(principal: TenantPrincipal, newCatalogKey: string, now?: () => Date) {
    return db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey }, { provider, now }))
  }

  it('applies an upgrade immediately: updates the catalog key and grants the ceiling delta once', async () => {
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })
    const now = () => new Date('2026-03-16T00:00:00Z')
    const preview = await previewAndFingerprint(principal, 'pro_max_monthly', now)

    const result = await db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_max_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider, now }))

    expect(result.applied).toBe('immediate')
    expect(result.creditDelta).toBeGreaterThan(0)
    const row = await readSubscription(stripeSubscriptionId)
    expect(row.catalogKey).toBe('pro_max_monthly')
    expect(row.tier).toBe('pro_max')

    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.sourceReference, stripeSubscriptionId))
    expect(grants).toHaveLength(1)
    expect(grants[0].originalUnits).toBe(result.creditDelta)
    expect(grants[0].source).toBe('subscription_upgrade_delta')
  })

  it('a retried call with the same idempotency key does not grant a second batch of credits', async () => {
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })
    const now = () => new Date('2026-03-16T00:00:00Z')
    const preview = await previewAndFingerprint(principal, 'team_monthly', now)
    const idempotencyKey = uniqueId('idem')

    await db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'team_monthly', fingerprint: preview.fingerprint, idempotencyKey }, { provider, now }))
    await db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'team_monthly', fingerprint: preview.fingerprint, idempotencyKey }, { provider, now }))

    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.sourceReference, stripeSubscriptionId))
    expect(grants).toHaveLength(1)
  })

  it('applies monthly-to-annual at the same tier immediately without a duplicate grant', async () => {
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })
    const preview = await previewAndFingerprint(principal, 'pro_annual')

    const result = await db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_annual', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider }))

    expect(result.applied).toBe('immediate')
    expect(result.creditDelta).toBe(0)
    const row = await readSubscription(stripeSubscriptionId)
    expect(row.interval).toBe('annual')
    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.sourceReference, stripeSubscriptionId))
    expect(grants).toHaveLength(0)
  })

  it('schedules a downgrade at the period end without touching the current catalog key or charging now', async () => {
    const principal = await freshOrgWithOwner()
    const periodEnd = new Date('2026-04-01T00:00:00Z')
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly', currentPeriodEnd: periodEnd })
    const preview = await previewAndFingerprint(principal, 'pro_monthly')

    const result = await db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider }))

    expect(result.applied).toBe('scheduled')
    expect(result.effectiveAt).toBe(periodEnd.toISOString())
    const row = await readSubscription(stripeSubscriptionId)
    expect(row.catalogKey).toBe('team_monthly') // unchanged now
    expect(row.scheduledChange).toEqual({ catalogKey: 'pro_monthly', effectiveAt: periodEnd.toISOString() })
    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.sourceReference, stripeSubscriptionId))
    expect(grants).toHaveLength(0)
  })

  it('refuses to schedule (and never touches the provider) while accepted members exceed the target seat limit', async () => {
    mocks.getSeatUsage.mockResolvedValue({ used: 3, limit: 10 })
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly' })
    const changeSpy = vi.spyOn(provider, 'changeSubscription')
    const preview = await previewAndFingerprint(principal, 'pro_monthly')

    await expect(db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider })))
      .rejects.toMatchObject({ code: 'seat_limit_exceeded', seatBlocker: { currentSeatsUsed: 3, targetSeatLimit: 1, manageTeamUrl: '/settings/team' } })

    expect(changeSpy).not.toHaveBeenCalled()
    const row = await readSubscription(stripeSubscriptionId)
    expect(row.catalogKey).toBe('team_monthly')
    expect(row.scheduledChange).toBeNull()
  })

  it('refuses to schedule while a usable (pending) invitation alone exceeds the target seat limit', async () => {
    mocks.getSeatUsage.mockResolvedValue({ used: 2, limit: 10 }) // 1 accepted member + 1 pending invitation
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly' })
    const preview = await previewAndFingerprint(principal, 'pro_monthly')

    await expect(db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider })))
      .rejects.toMatchObject({ code: 'seat_limit_exceeded' })
  })

  it('allows the downgrade once seats are freed down to exactly the target limit', async () => {
    mocks.getSeatUsage.mockResolvedValue({ used: 1, limit: 10 })
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly' })
    const preview = await previewAndFingerprint(principal, 'pro_monthly')

    const result = await db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider }))

    expect(result.applied).toBe('scheduled')
    const row = await readSubscription(stripeSubscriptionId)
    expect(row.scheduledChange).toEqual({ catalogKey: 'pro_monthly', effectiveAt: row.currentPeriodEnd?.toISOString() })
  })

  it('two concurrent downgrade requests while over the seat limit both refuse, never scheduling either', async () => {
    mocks.getSeatUsage.mockResolvedValue({ used: 5, limit: 10 })
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'team_monthly', tier: 'team', interval: 'monthly' })
    const preview = await previewAndFingerprint(principal, 'pro_monthly')

    const results = await Promise.allSettled([
      db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider })),
      db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider })),
    ])

    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    const row = await readSubscription(stripeSubscriptionId)
    expect(row.scheduledChange).toBeNull()
  })

  it('rejects a stale preview once the subscription has changed since it was generated', async () => {
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', providerSyncedAt: new Date('2026-03-01T00:00:00Z') })
    const preview = await previewAndFingerprint(principal, 'pro_max_monthly')

    // Simulate a webhook bumping providerSyncedAt after the preview was computed.
    await db.update(billingSubscriptions).set({ providerSyncedAt: new Date('2026-03-10T00:00:00Z') }).where(eq(billingSubscriptions.organizationId, principal.organizationId))

    await expect(db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_max_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider })))
      .rejects.toMatchObject({ code: 'stale_preview' })
  })

  it('does not apply the change when the payment is declined', async () => {
    const decliningProvider = new DecliningProvider()
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })
    const preview = await db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_max_monthly' }, { provider }))

    await expect(db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_max_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider: decliningProvider })))
      .rejects.toMatchObject({ code: 'payment_failed' })

    const row = await readSubscription(stripeSubscriptionId)
    expect(row.catalogKey).toBe('pro_monthly')
    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.sourceReference, stripeSubscriptionId))
    expect(grants).toHaveLength(0)
  })

  it('does not apply the change when SCA/3DS is still required', async () => {
    const scaProvider = new ScaRequiredProvider()
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })
    const preview = await db.transaction((tx) => previewSubscriptionChange(tx, principal, { newCatalogKey: 'pro_max_monthly' }, { provider }))

    await expect(db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_max_monthly', fingerprint: preview.fingerprint, idempotencyKey: uniqueId('idem') }, { provider: scaProvider })))
      .rejects.toMatchObject({ code: 'requires_action' })

    const row = await readSubscription(stripeSubscriptionId)
    expect(row.catalogKey).toBe('pro_monthly')
  })

  it('two concurrent requests for the same change converge on exactly one applied result and one grant', async () => {
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly' })
    const now = () => new Date('2026-03-16T00:00:00Z')
    const preview = await previewAndFingerprint(principal, 'pro_max_monthly', now)
    const idempotencyKey = uniqueId('idem')

    const [first, second] = await Promise.all([
      db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_max_monthly', fingerprint: preview.fingerprint, idempotencyKey }, { provider, now })),
      db.transaction((tx) => changeSubscription(tx, principal, { newCatalogKey: 'pro_max_monthly', fingerprint: preview.fingerprint, idempotencyKey }, { provider, now })),
    ])

    expect(first.creditDelta).toBe(second.creditDelta)
    const grants = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.sourceReference, stripeSubscriptionId))
    expect(grants).toHaveLength(1)
  })
})

describe('cancelSubscriptionAtPeriodEnd', () => {
  let provider: FakeBillingProvider
  beforeEach(() => { provider = new FakeBillingProvider() })

  it('schedules cancellation for the current period end and marks cancelAtPeriodEnd', async () => {
    const principal = await freshOrgWithOwner()
    const periodEnd = new Date('2026-04-01T00:00:00Z')
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider, { currentPeriodEnd: periodEnd })

    const result = await db.transaction((tx) => cancelSubscriptionAtPeriodEnd(tx, principal, { provider }))

    expect(result).toEqual({ cancelAtPeriodEnd: true, effectiveAt: periodEnd.toISOString() })
    const row = await readSubscription(stripeSubscriptionId)
    expect(row.cancelAtPeriodEnd).toBe(true)
    expect(row.canceledAt).toBeNull() // never immediately terminated
    expect(row.stripeStatus).toBe('active') // access continues through the paid period
  })

  it('never cancels immediately — the provider is asked for atPeriodEnd: true, never an immediate cancellation', async () => {
    const principal = await freshOrgWithOwner()
    await seedActiveSubscription(principal.organizationId, provider)
    const cancelSpy = vi.spyOn(provider, 'cancelSubscription')

    await db.transaction((tx) => cancelSubscriptionAtPeriodEnd(tx, principal, { provider }))

    expect(cancelSpy).toHaveBeenCalledWith(expect.objectContaining({ atPeriodEnd: true }))
  })

  it('a duplicate cancellation request is an idempotent no-op, not an error', async () => {
    const principal = await freshOrgWithOwner()
    const stripeSubscriptionId = await seedActiveSubscription(principal.organizationId, provider)
    const cancelSpy = vi.spyOn(provider, 'cancelSubscription')

    const first = await db.transaction((tx) => cancelSubscriptionAtPeriodEnd(tx, principal, { provider }))
    const second = await db.transaction((tx) => cancelSubscriptionAtPeriodEnd(tx, principal, { provider }))

    expect(first).toEqual(second)
    expect(cancelSpy).toHaveBeenCalledTimes(1) // the second call recognizes it's already scheduled and never re-calls the provider
    const row = await readSubscription(stripeSubscriptionId)
    expect(row.cancelAtPeriodEnd).toBe(true)
  })

  it('rejects when there is no active subscription', async () => {
    const principal = await freshOrgWithOwner()
    await expect(db.transaction((tx) => cancelSubscriptionAtPeriodEnd(tx, principal, { provider })))
      .rejects.toMatchObject({ code: 'no_active_subscription' })
  })
})
