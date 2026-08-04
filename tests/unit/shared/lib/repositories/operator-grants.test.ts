/**
 * The canonical operator grant (`src/shared/lib/repositories/operator-grants.ts`).
 *
 * This replaces `setPlatformUserPlan`, which wrote the per-**user** `plans` table. The subject changing from a
 * person to an organization is the whole point, so the tests below are about the properties that only make sense
 * once it does: one entitlement per organization, seats decided by the tier rather than by the caller, and a
 * grant that never pretends to be a Stripe subscription.
 *
 * ## What this file cannot prove, stated because it already hid a real defect
 *
 * It runs against a disposable database **as the migration role**, which sees no GRANTs and no RLS. The first
 * version of this repository wrote `organization_entitlements` directly through `platformDb`; these tests passed
 * while the feature was dead in production, because `builderhunt_platform` has no privilege on that table at
 * all. An e2e test clicking Save on `/admin/users` is what caught it.
 *
 * So this file now covers the *logic* — which tiers are grantable, what seats a tier carries, what a re-grant
 * does to an old expiry — and the **role** behaviour is proven where it can be: `scripts/db/verify-rls-local.mjs`
 * calls the grant as the real `builderhunt_platform` role and asserts that the same write attempted directly
 * against the table is refused. Both halves are needed; neither substitutes for the other.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { organizationEntitlements, organizations } from '~/shared/lib/db/schema'

const mocks = vi.hoisted(() => ({ platformDb: null as unknown }))

vi.mock('~/shared/lib/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/db/client')>()
  return {
    ...actual,
    get platformDb() { return mocks.platformDb },
  }
})

const { grantOrganizationEntitlement, OperatorGrantError } =
  await import('~/shared/lib/repositories/operator-grants')

let drop: () => Promise<void>
let db: Awaited<ReturnType<typeof createDisposableTestDatabase>>['db']

const ORG = 'og-org-a'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('operator_grants')
  db = disposable.db
  drop = disposable.drop
  mocks.platformDb = db
  await db.insert(organizations).values({ id: ORG, name: ORG, slug: ORG, createdAt: new Date() })
})

afterAll(async () => {
  await drop()
})

async function readRow() {
  const [row] = await db.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, ORG))
  return row
}

describe('grantOrganizationEntitlement', () => {
  it('creates the entitlement when the organization has none', async () => {
    const result = await grantOrganizationEntitlement({ organizationId: ORG, tier: 'team', notes: 'design partner' })

    expect(result.tier).toBe('team')
    expect(result.status).toBe('active')
    expect(result.notes).toBe('design partner')

    const row = await readRow()
    expect(row!.tier).toBe('team')
    expect(row!.seatLimit, 'a team grant must carry team seats').toBe(10)
  })

  it('updates in place rather than creating a second entitlement', async () => {
    // `organization_id` is the primary key, so a second row is impossible at the database level. The property
    // worth asserting is that the *upsert* path is taken: a grant applied twice must leave the latest values,
    // not fail on a conflict and leave the first.
    await grantOrganizationEntitlement({ organizationId: ORG, tier: 'pro', notes: 'downgraded after pilot' })

    const rows = await db.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, ORG))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tier).toBe('pro')
    expect(rows[0]!.notes).toBe('downgraded after pilot')
  })

  it('derives seats from the tier, so an operator cannot sell seats a tier does not include', async () => {
    /**
     * The reason `seatLimit` is not a parameter. An operator able to set 500 seats on `free` would make every
     * seat check a statement about nothing — the tier would stop meaning what the pricing page says it means.
     */
    await grantOrganizationEntitlement({ organizationId: ORG, tier: 'free' })
    expect((await readRow())!.seatLimit).toBe(1)

    await grantOrganizationEntitlement({ organizationId: ORG, tier: 'team' })
    expect((await readRow())!.seatLimit).toBe(10)
  })

  it('never claims a billing period, because nothing is being billed on a cycle', async () => {
    /**
     * A stale `monthly` here would make the billing page show a renewal date that will never arrive — the
     * customer would be told they are about to be charged for something nobody is charging them for.
     */
    await grantOrganizationEntitlement({ organizationId: ORG, tier: 'pro' })
    expect((await readRow())!.billingPeriod).toBe('none')
  })

  it('carries a trial expiry when one is given, and clears it when it is not', async () => {
    const expires = new Date('2026-12-31T00:00:00Z')
    await grantOrganizationEntitlement({ organizationId: ORG, tier: 'pro', trialEndsAt: expires })
    expect((await readRow())!.trialEndsAt?.toISOString()).toBe(expires.toISOString())

    // Omitting it must clear rather than preserve: a re-grant that silently kept an old expiry would end a
    // customer's access on a date the operator thought they had removed.
    await grantOrganizationEntitlement({ organizationId: ORG, tier: 'pro' })
    expect((await readRow())!.trialEndsAt).toBeNull()
  })

  it('refuses an unknown organization instead of creating an orphan entitlement', async () => {
    await expect(grantOrganizationEntitlement({ organizationId: 'og-org-nope', tier: 'pro' }))
      .rejects.toMatchObject({ code: 'unknown_organization' })
  })

  it('refuses pro_max — it can only come from a real Stripe subscription', async () => {
    /**
     * Previously this file asserted the opposite: that a `pro_max` grant succeeded and carried one seat. That
     * contradicted three other statements of the same rule — the admin route's named test, the
     * `organization_plan_changes` tier CHECK, and 30-stripe-billing-platform/tasks.md's explicit note that the
     * manual-grant trail "can never produce Pro Max". The type now excludes it, so this needs a cast to even
     * express, and `drizzle/0141`'s function refuses it independently for any caller that bypasses the type.
     */
    await expect(grantOrganizationEntitlement({ organizationId: ORG, tier: 'pro_max' as never }))
      .rejects.toMatchObject({ code: 'invalid_tier' })
  })

  it('refuses a tier that is not grantable at all', async () => {
    await expect(grantOrganizationEntitlement({ organizationId: ORG, tier: 'enterprise' as never }))
      .rejects.toBeInstanceOf(OperatorGrantError)
  })
})
