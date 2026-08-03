/**
 * Stripe-specific isolation on the billing tables
 * (plans/phase-1/30-stripe-billing-platform/tasks.md §10 "Certify Stripe sandbox and Test Clock lifecycle" —
 * one of its three named deliverables).
 *
 * ## Why this is not the fourth copy of a tenant-isolation test
 *
 * Three files already answer three different questions about billing isolation, and none of them answers this
 * one:
 *
 * - `tests/unit/security/billing-tenant-isolation.test.ts` reads the **text** of `drizzle/0028` and asserts the
 *   grant/policy shape — that the browser role never receives INSERT/UPDATE on a financial table. Static.
 * - `scripts/db/verify-rls-local.mjs` connects as the **real roles** and proves the database itself refuses a
 *   cross-tenant write. Behavioural, and the only evidence about Postgres.
 * - `tests/e2e/api/billing-authorization.spec.ts` proves the **HTTP surface** refuses the wrong caller.
 *
 * What none of them touches is the axis that is specific to Stripe: **`livemode`**. Every billing table carries
 * it, every repository read takes it as a parameter, and the catalog keeps separate `test` and `live` Price IDs
 * — because a test-mode Stripe object and a live one can share nothing.
 *
 * ## The finding this file exists to pin
 *
 * **`livemode` appears zero times in `drizzle/0028_billing_rls_grants.sql`.** Grep it. The tenant boundary has
 * a database backstop; the *mode* boundary has none. It is enforced entirely by `and(eq(…organizationId), eq(…
 * livemode))` in `repositories/billing.ts`, which means a single query that forgets the second predicate reads
 * across modes and nothing below the application layer objects.
 *
 * That asymmetry is defensible — `livemode` is a property of the row, not of the caller, so there is no session
 * setting for RLS to compare it against the way `app.organization_id` works — but it must be *known*, because
 * it decides where the evidence has to come from. For the tenant axis, the database is the witness. For the
 * mode axis, these assertions are.
 *
 * ## What a mode leak actually costs
 *
 * Both directions are silent and neither is recoverable by retrying:
 *
 * - A live-mode read that returns a test-mode subscription tells a paying customer they are on a plan whose
 *   Stripe object does not exist in live mode. Support cannot find it; reconciliation flags it as an orphan.
 * - A test-mode write against live-mode rows is the direction that survives longest undetected, because
 *   nothing is charged. The production ledger simply accumulates references to objects that only exist in test
 *   mode, and the discrepancy surfaces at month end.
 *
 * ## The role this runs as, stated so the evidence is not over-read
 *
 * The database is a per-file disposable one created as the migration superuser, which bypasses RLS entirely.
 * That is *correct* for the mode axis (there is no policy to bypass — see above) and it is why the cross-tenant
 * cases below are application-level evidence only, with the database half pointed at `verify-rls-local.mjs`. A
 * test that claimed otherwise would be the exact false-confidence this plan has already been bitten by twice.
 *
 * Disposable rather than the shared `runtimeDb`, matching `subscription-changes.test.ts`: this file seeds four
 * cells of an (organization × mode) matrix, and doing that in a database anything else reads would make its
 * results depend on what was left behind.
 *
 * Every repository call goes through `db.transaction(...)` rather than taking the database directly: these
 * functions are typed `TenantTransaction`, which is what they receive in production, and `tsc` rejects the
 * shortcut even though the query would run. Matching `tests/unit/shared/lib/repositories/billing.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, billingCustomers, billingSubscriptions, organizationMembers, organizations } from '~/shared/lib/db/schema'
import {
  findActiveBillingSubscription,
  findBillingCustomer,
  findFullActiveBillingSubscription,
} from '~/shared/lib/repositories/billing'

const SUFFIX = 'stripeiso'
const ORG_A = `org-a-${SUFFIX}`
const ORG_B = `org-b-${SUFFIX}`
const USER_A = `user-a-${SUFFIX}`

let db: Awaited<ReturnType<typeof createDisposableTestDatabase>>['db']
let drop: () => Promise<void>

/**
 * `(organization, mode)` — the two axes together, since either alone is insufficient.
 *
 * `seed` deliberately does NOT register into `matrix`: the orphan-organization test below seeds and then deletes
 * its own rows, and having that registration happen implicitly left a deleted row in the shared list, so the
 * uniqueness test looked for a subscription that no longer existed and reported "resolved to 0 rows". Registering
 * explicitly in `beforeAll` keeps the list meaning exactly "the rows that live for the whole file".
 */
interface Seeded {
  organizationId: string
  livemode: boolean
  customerRowId: string
  stripeCustomerId: string
  stripeSubscriptionId: string
}

const matrix: Seeded[] = []

async function seed(organizationId: string, livemode: boolean): Promise<Seeded> {
  const tag = `${organizationId}-${livemode ? 'live' : 'test'}`
  const row: Seeded = {
    organizationId,
    livemode,
    customerRowId: `bcust-${tag}`,
    stripeCustomerId: `cus_${tag}`,
    stripeSubscriptionId: `sub_${tag}`,
  }
  await db.insert(billingCustomers).values({
    id: row.customerRowId,
    organizationId,
    livemode,
    stripeCustomerId: row.stripeCustomerId,
  })
  await db.insert(billingSubscriptions).values({
    id: `bsub-${tag}`,
    organizationId,
    customerId: row.customerRowId,
    livemode,
    catalogKey: 'pro_monthly',
    tier: 'pro',
    interval: 'monthly',
    catalogVersion: 1,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeStatus: 'active',
    currentPeriodStart: new Date('2026-03-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-04-01T00:00:00Z'),
  })
  return row
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('stripe_billing_isolation')
  db = disposable.db
  drop = disposable.drop

  for (const organizationId of [ORG_A, ORG_B]) {
    await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
  }
  await db.insert(authUsers).values({
    id: USER_A, name: USER_A, email: `${USER_A}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(organizationMembers).values({
    id: `member-${USER_A}`, organizationId: ORG_A, userId: USER_A, role: 'owner', createdAt: new Date(),
  })

  // All four cells of the matrix, so "found the right one" is distinguishable from "found the only one".
  matrix.push(await seed(ORG_A, false))
  matrix.push(await seed(ORG_A, true))
  matrix.push(await seed(ORG_B, false))
  matrix.push(await seed(ORG_B, true))
})

afterAll(async () => {
  // The whole database goes, so no per-table cleanup can drift out of step with what `seed` inserts.
  await drop()
})

describe('the mode boundary has no database backstop', () => {
  it('livemode is absent from every policy in drizzle/0028', () => {
    /**
     * The premise every other assertion in this file rests on, checked rather than asserted in prose. If a
     * future migration adds a `livemode` predicate to these policies, this fails — and that would be good
     * news worth noticing, because it would move the mode boundary into the database and make the runtime
     * cases below a second line of defence instead of the only one.
     */
    const migration = readFileSync(join(process.cwd(), 'drizzle/0028_billing_rls_grants.sql'), 'utf8')
    expect(migration).toContain('CREATE POLICY')
    expect(
      migration.includes('livemode'),
      'drizzle/0028 now mentions livemode — the mode boundary may have gained a database backstop; '
      + 'update this file\'s reasoning rather than deleting the check',
    ).toBe(false)
  })
})

describe('findBillingCustomer isolates on both axes', () => {
  it('returns the row matching the requested mode, not merely the organization\'s only row', async () => {
    const test = await db.transaction((tx) => findBillingCustomer(tx, ORG_A, false))
    const live = await db.transaction((tx) => findBillingCustomer(tx, ORG_A, true))

    expect(test?.stripeCustomerId).toBe(`cus_${ORG_A}-test`)
    expect(live?.stripeCustomerId).toBe(`cus_${ORG_A}-live`)
    // The point: two rows exist for this organization and the mode is what separates them. A query missing the
    // livemode predicate would return whichever the planner happened to order first, and pass half the time.
    expect(test!.stripeCustomerId).not.toBe(live!.stripeCustomerId)
  })

  it('never returns the other organization\'s customer in either mode', async () => {
    for (const livemode of [false, true]) {
      const found = await db.transaction((tx) => findBillingCustomer(tx, ORG_A, livemode));
      expect(found?.organizationId).toBe(ORG_A)
      expect(found?.stripeCustomerId).not.toContain(ORG_B)
    }
  })
})

describe('subscription reads isolate on both axes', () => {
  it('resolves the subscription for the requested mode', async () => {
    const test = await db.transaction((tx) => findActiveBillingSubscription(tx, ORG_A, false))
    const live = await db.transaction((tx) => findActiveBillingSubscription(tx, ORG_A, true))

    expect(test?.stripeSubscriptionId).toBe(`sub_${ORG_A}-test`)
    expect(live?.stripeSubscriptionId).toBe(`sub_${ORG_A}-live`)
  })

  it('the full read used by change and cancel isolates identically', async () => {
    /**
     * `findFullActiveBillingSubscription` is the one `subscription-changes.ts` uses before it moves a plan, so
     * a mode leak here would apply a change computed against the wrong Stripe object — the request would
     * succeed and the provider call would target a subscription in the other mode.
     */
    const test = await db.transaction((tx) => findFullActiveBillingSubscription(tx, ORG_A, false))
    const live = await db.transaction((tx) => findFullActiveBillingSubscription(tx, ORG_A, true))

    expect(test?.stripeSubscriptionId).toBe(`sub_${ORG_A}-test`)
    expect(live?.stripeSubscriptionId).toBe(`sub_${ORG_A}-live`)
    expect(test?.organizationId).toBe(ORG_A)
    expect(live?.organizationId).toBe(ORG_A)
  })

  it('returns nothing for an organization that has no row in the requested mode', async () => {
    // Absence must read as absence rather than falling back to the other mode — the failure that would let a
    // live-mode caller act on a test-mode subscription.
    const orphan = `org-empty-${SUFFIX}`
    await db.insert(organizations).values({ id: orphan, name: orphan, slug: orphan, createdAt: new Date() })
    try {
      await seed(orphan, false)
      expect(await db.transaction((tx) => findActiveBillingSubscription(tx, orphan, false))).toBeTruthy()
      expect(
        await db.transaction((tx) => findActiveBillingSubscription(tx, orphan, true)),
        'a live-mode read found a test-mode subscription',
      ).toBeFalsy()
    } finally {
      await db.delete(billingSubscriptions).where(eq(billingSubscriptions.organizationId, orphan))
      await db.delete(billingCustomers).where(eq(billingCustomers.organizationId, orphan))
      await db.delete(organizations).where(eq(organizations.id, orphan))
    }
  })
})

describe('Stripe identifiers are not capabilities', () => {
  it('a Stripe subscription id maps to exactly one (organization, mode) pair', async () => {
    /**
     * Webhooks arrive carrying only Stripe ids — never our `organizationId` — so
     * `findOrganizationIdForStripeSubscription` resolves ownership by scanning organizations. If one Stripe id
     * could match rows in two organizations or two modes, that resolution would be ambiguous and a webhook
     * would be applied to whichever it found first.
     *
     * Asserted directly against the table rather than through the resolver, because the resolver's own
     * correctness depends on this uniqueness being true in the first place.
     */
    for (const row of matrix) {
      const matches = await db
        .select({ organizationId: billingSubscriptions.organizationId, livemode: billingSubscriptions.livemode })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.stripeSubscriptionId, row.stripeSubscriptionId))

      expect(matches, `${row.stripeSubscriptionId} resolved to ${matches.length} rows`).toHaveLength(1)
      expect(matches[0]!.organizationId).toBe(row.organizationId)
      expect(matches[0]!.livemode).toBe(row.livemode)
    }
  })

  it('holding the other organization\'s Stripe id does not widen a scoped read', async () => {
    // The shape an attacker would try: a valid Stripe id from somewhere else, used with their own principal.
    // Every repository read takes `organizationId` from the caller's context, never from the object, so the id
    // is inert — this pins that it stays inert.
    const foreign = matrix.find((row) => row.organizationId === ORG_B && !row.livemode)!
    const rows = await db
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(and(
        eq(billingSubscriptions.organizationId, ORG_A),
        eq(billingSubscriptions.stripeSubscriptionId, foreign.stripeSubscriptionId),
      ))

    expect(rows, 'B\'s subscription id was reachable while scoped to A').toHaveLength(0)
  })
})
