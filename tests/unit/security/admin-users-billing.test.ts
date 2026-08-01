/**
 * plans/UI/tasks.md Wave 5 "Align Admin Users with organization-owned billing".
 *
 * `getPlatformUserBillingSummary` against a real database — proves the four distinguishable
 * fixtures the task's own verify line names: canonical paid (a live Stripe subscription),
 * manual exception (admin-granted, no subscription), expired exception (same, but its own period
 * has passed), and no-organization (the user owns nothing at all).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers,
  billingCustomers,
  billingSubscriptions,
  organizationEntitlements,
  organizationMembers,
  organizations,
} from '~/shared/lib/db/schema'
import { getPlatformUserBillingSummary } from '~/shared/lib/repositories/platform-billing'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('admin_users_billing')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(billingSubscriptions)
  await db.delete(billingCustomers)
  await db.delete(organizationEntitlements)
  await db.delete(organizationMembers)
  await db.delete(organizations)
  await db.delete(authUsers)
})

let seq = 0
async function seedUserWithOrg(overrides: {
  tier?: string
  entitlementStatus?: string
  currentPeriodEnd?: Date | null
  hasActiveSubscription?: boolean
  asOwner?: boolean
} = {}) {
  seq += 1
  const userId = `u-${seq}`
  const orgId = `org-${seq}`
  await db.insert(authUsers).values({ id: userId, name: `User ${seq}`, email: `u${seq}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizations).values({ id: orgId, name: `Org ${seq}`, slug: `org-${seq}` })
  await db.insert(organizationMembers).values({ id: `mem-${seq}`, organizationId: orgId, userId, role: overrides.asOwner === false ? 'member' : 'owner' })
  if (overrides.tier) {
    await db.insert(organizationEntitlements).values({
      organizationId: orgId,
      tier: overrides.tier,
      status: overrides.entitlementStatus ?? 'active',
      currentPeriodEnd: overrides.currentPeriodEnd ?? null,
    })
  }
  if (overrides.hasActiveSubscription) {
    await db.insert(billingCustomers).values({ id: `cust-${seq}`, organizationId: orgId, livemode: false, stripeCustomerId: `cus_${seq}` })
    await db.insert(billingSubscriptions).values({
      id: `sub-${seq}`,
      organizationId: orgId,
      customerId: `cust-${seq}`,
      livemode: false,
      catalogKey: 'pro-monthly',
      tier: overrides.tier ?? 'pro',
      interval: 'monthly',
      catalogVersion: 1,
      stripeSubscriptionId: `sub_stripe_${seq}`,
      stripeStatus: 'active',
      canceledAt: null,
    })
  }
  return { userId, orgId }
}

describe('getPlatformUserBillingSummary', () => {
  it('returns null (no-organization) for a user who owns no organization', async () => {
    await db.insert(authUsers).values({ id: 'lonely', name: 'Lonely', email: 'lonely@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    expect(await getPlatformUserBillingSummary('lonely', new Date(), db as never)).toBeNull()
  })

  it('is canonical when a live Stripe subscription backs the entitlement', async () => {
    const { userId } = await seedUserWithOrg({ tier: 'pro', hasActiveSubscription: true })
    const summary = await getPlatformUserBillingSummary(userId, new Date(), db as never)
    expect(summary!.provenance).toBe('canonical')
    expect(summary!.entitlementTier).toBe('pro')
  })

  it('is canonical (not an exception) for a plain free-tier organization, but is not shown as Stripe-backed', async () => {
    const { userId } = await seedUserWithOrg({ tier: 'free' })
    const summary = await getPlatformUserBillingSummary(userId, new Date(), db as never)
    expect(summary!.provenance).toBe('canonical')
    // "canonical" (not an exception) and "has a real subscription" are different facts — a plain
    // free org is the former without being the latter, and a UI badge for "Stripe-backed" must gate
    // on this field, not on provenance alone.
    expect(summary!.hasActiveSubscription).toBe(false)
  })

  it('is a manual exception when the tier is non-free with no matching subscription', async () => {
    const { userId } = await seedUserWithOrg({ tier: 'team', currentPeriodEnd: new Date(Date.now() + 86_400_000) })
    const summary = await getPlatformUserBillingSummary(userId, new Date(), db as never)
    expect(summary!.provenance).toBe('manual_exception')
  })

  it('is an expired exception once the manual grant\'s own period has passed', async () => {
    const { userId } = await seedUserWithOrg({ tier: 'team', currentPeriodEnd: new Date(Date.now() - 86_400_000) })
    const summary = await getPlatformUserBillingSummary(userId, new Date(), db as never)
    expect(summary!.provenance).toBe('expired_exception')
  })

  it('reports Pro Max as the canonical tier when it is Stripe-backed', async () => {
    const { userId } = await seedUserWithOrg({ tier: 'pro_max', hasActiveSubscription: true })
    const summary = await getPlatformUserBillingSummary(userId, new Date(), db as never)
    expect(summary!.entitlementTier).toBe('pro_max')
    expect(summary!.provenance).toBe('canonical')
  })

  it('only considers organizations the user owns, not ones they merely belong to', async () => {
    const { userId } = await seedUserWithOrg({ tier: 'team', asOwner: false })
    expect(await getPlatformUserBillingSummary(userId, new Date(), db as never)).toBeNull()
  })

  it('never returns a raw Stripe id or customer id', async () => {
    const { userId } = await seedUserWithOrg({ tier: 'pro', hasActiveSubscription: true })
    const summary = await getPlatformUserBillingSummary(userId, new Date(), db as never)
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('sub_stripe_')
    expect(serialized).not.toContain('cus_')
  })
})
