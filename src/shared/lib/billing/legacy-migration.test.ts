import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingCreditGrants, billingCustomers, billingSubscriptions, organizationEntitlements, organizationMembers, organizations } from '../db/schema'
import {
  computeLegacyMigrationChecksum,
  endOverlappingManualAuthority,
  importLegacyEntitlementAsCredits,
  resolveLegacyGrantExpiry,
  resolveLegacyMonthlyCredits,
} from './legacy-migration'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `legacy-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('legacy_migration')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

async function freshOrg(): Promise<string> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizationMembers).values({ id: uniqueId('member'), organizationId: orgId, userId, role: 'owner', createdAt: new Date() })
  return orgId
}

function importLegacy(input: Parameters<typeof importLegacyEntitlementAsCredits>[1]) {
  return db.transaction((tx) => importLegacyEntitlementAsCredits(tx, input))
}

function endOverlapping(organizationId: string) {
  return db.transaction((tx) => endOverlappingManualAuthority(tx, organizationId))
}

async function seedEntitlement(organizationId: string, overrides: Partial<{ tier: string; currentPeriodEnd: Date | null; trialEndsAt: Date | null; notes: string | null }> = {}): Promise<void> {
  await db.insert(organizationEntitlements).values({
    organizationId,
    tier: overrides.tier ?? 'pro',
    status: 'active',
    billingPeriod: 'none',
    currentPeriodEnd: overrides.currentPeriodEnd ?? null,
    trialEndsAt: overrides.trialEndsAt ?? null,
    notes: overrides.notes ?? null,
  })
}

describe('resolveLegacyMonthlyCredits', () => {
  it('resolves pro and team to their catalog monthly credit amounts', () => {
    expect(resolveLegacyMonthlyCredits('pro')).toBe(140)
    expect(resolveLegacyMonthlyCredits('team')).toBe(2100)
  })

  it('returns null for free and any unresolvable tier', () => {
    expect(resolveLegacyMonthlyCredits('free')).toBeNull()
    expect(resolveLegacyMonthlyCredits('pro_max')).toBeNull()
    expect(resolveLegacyMonthlyCredits('nonsense')).toBeNull()
  })
})

describe('resolveLegacyGrantExpiry', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('prefers currentPeriodEnd when set', () => {
    const periodEnd = new Date('2026-06-01T00:00:00Z')
    expect(resolveLegacyGrantExpiry({ currentPeriodEnd: periodEnd, trialEndsAt: new Date('2026-02-01T00:00:00Z') }, now)).toEqual(periodEnd)
  })

  it('falls back to trialEndsAt when currentPeriodEnd is null', () => {
    const trialEnd = new Date('2026-02-01T00:00:00Z')
    expect(resolveLegacyGrantExpiry({ currentPeriodEnd: null, trialEndsAt: trialEnd }, now)).toEqual(trialEnd)
  })

  it('falls back to a ten-year-out date when neither is set', () => {
    const expiry = resolveLegacyGrantExpiry({ currentPeriodEnd: null, trialEndsAt: null }, now)
    expect(expiry.getUTCFullYear()).toBe(2036)
  })
})

describe('importLegacyEntitlementAsCredits', () => {
  it('skips a free-tier organization — nothing to migrate', async () => {
    const orgId = await freshOrg()
    const outcome = await importLegacy({ organizationId: orgId, tier: 'free', currentPeriodEnd: null, trialEndsAt: null })
    expect(outcome).toEqual({ outcome: 'skipped_free_tier' })
  })

  it('skips an organization that already has a real Stripe subscription', async () => {
    const orgId = await freshOrg()
    const customerId = uniqueId('cust-row')
    await db.insert(billingCustomers).values({ id: customerId, organizationId: orgId, livemode: false, stripeCustomerId: `cus_${customerId}` })
    await db.insert(billingSubscriptions).values({
      id: uniqueId('sub-row'), organizationId: orgId, customerId, livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus: 'active',
    })

    const outcome = await importLegacy({ organizationId: orgId, tier: 'pro', currentPeriodEnd: null, trialEndsAt: null })

    expect(outcome).toEqual({ outcome: 'skipped_already_has_subscription' })
  })

  it('reports a conflict for a tier that cannot be resolved to a catalog credit amount', async () => {
    const orgId = await freshOrg()
    const outcome = await importLegacy({ organizationId: orgId, tier: 'pro_max', currentPeriodEnd: null, trialEndsAt: null })
    expect(outcome).toEqual({ outcome: 'conflict_unresolvable_tier' })
  })

  it('migrates a pro-tier organization, creating a legacy_manual grant with the catalog credit amount and the entitlement period end as expiry', async () => {
    const orgId = await freshOrg()
    const periodEnd = new Date('2027-01-01T00:00:00Z')

    const outcome = await importLegacy({ organizationId: orgId, tier: 'pro', currentPeriodEnd: periodEnd, trialEndsAt: null })

    expect(outcome).toEqual({ outcome: 'migrated', grantId: expect.any(String), units: 140, expiresAt: periodEnd })
    const [row] = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, orgId))
    expect(row).toMatchObject({ source: 'legacy_manual', originalUnits: 140, remainingUnits: 140, state: 'active' })
  })

  it('a rerun for an already-migrated organization is a no-op, not a second grant', async () => {
    const orgId = await freshOrg()
    const periodEnd = new Date('2027-01-01T00:00:00Z')

    await importLegacy({ organizationId: orgId, tier: 'pro', currentPeriodEnd: periodEnd, trialEndsAt: null })
    const second = await importLegacy({ organizationId: orgId, tier: 'pro', currentPeriodEnd: periodEnd, trialEndsAt: null })

    expect(second).toEqual({ outcome: 'skipped_already_migrated' })
    const rows = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, orgId))
    expect(rows).toHaveLength(1)
  })

  it('dryRun: true reports what WOULD happen without writing any row — the backfill script depends on this being a genuine no-write path', async () => {
    const orgId = await freshOrg()
    const periodEnd = new Date('2027-01-01T00:00:00Z')

    const outcome = await db.transaction((tx) => importLegacyEntitlementAsCredits(tx, { organizationId: orgId, tier: 'pro', currentPeriodEnd: periodEnd, trialEndsAt: null }, new Date(), true))

    expect(outcome).toEqual({ outcome: 'would_migrate', units: 140, expiresAt: periodEnd })
    const rows = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.organizationId, orgId))
    expect(rows).toHaveLength(0)
  })

  it('dryRun: true recognizes an organization already migrated by a prior real run', async () => {
    const orgId = await freshOrg()
    const periodEnd = new Date('2027-01-01T00:00:00Z')
    await importLegacy({ organizationId: orgId, tier: 'pro', currentPeriodEnd: periodEnd, trialEndsAt: null })

    const outcome = await db.transaction((tx) => importLegacyEntitlementAsCredits(tx, { organizationId: orgId, tier: 'pro', currentPeriodEnd: periodEnd, trialEndsAt: null }, new Date(), true))

    expect(outcome).toEqual({ outcome: 'skipped_already_migrated' })
  })
})

describe('endOverlappingManualAuthority', () => {
  it('expires an active legacy_manual grant and clears trialEndsAt/notes on voluntary Stripe cutover', async () => {
    const orgId = await freshOrg()
    await seedEntitlement(orgId, { trialEndsAt: new Date('2026-03-01T00:00:00Z'), notes: 'Manually granted by support' })
    const migrated = await importLegacy({ organizationId: orgId, tier: 'pro', currentPeriodEnd: new Date('2027-01-01T00:00:00Z'), trialEndsAt: null })
    if (migrated.outcome !== 'migrated') throw new Error('setup failed')

    await endOverlapping(orgId)

    const [grant] = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.id, migrated.grantId))
    expect(grant.state).toBe('expired')
    const [entitlement] = await db.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, orgId))
    expect(entitlement.trialEndsAt).toBeNull()
    expect(entitlement.notes).toBeNull()
  })

  it('is a no-op for an organization with no legacy_manual grant and no entitlement row', async () => {
    const orgId = await freshOrg()
    await expect(endOverlapping(orgId)).resolves.toBeUndefined()
  })
})

describe('computeLegacyMigrationChecksum', () => {
  it('is stable regardless of input order', () => {
    const a = [
      { organizationId: 'org-1', tier: 'pro', units: 140, expiresAt: new Date('2027-01-01T00:00:00Z') },
      { organizationId: 'org-2', tier: 'team', units: 2100, expiresAt: new Date('2027-02-01T00:00:00Z') },
    ]
    const b = [a[1], a[0]]
    expect(computeLegacyMigrationChecksum(a)).toBe(computeLegacyMigrationChecksum(b))
  })

  it('differs when the migrated data differs', () => {
    const a = [{ organizationId: 'org-1', tier: 'pro', units: 140, expiresAt: new Date('2027-01-01T00:00:00Z') }]
    const b = [{ organizationId: 'org-1', tier: 'pro', units: 140, expiresAt: new Date('2027-02-01T00:00:00Z') }]
    expect(computeLegacyMigrationChecksum(a)).not.toBe(computeLegacyMigrationChecksum(b))
  })
})
