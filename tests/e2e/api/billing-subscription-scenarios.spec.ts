/**
 * Subscription checkout and changes through the provider scenarios (plan 53, task 3).
 *
 * The sibling of `billing-checkout-scenarios.spec.ts`, and the properties differ in one important way. A
 * credit pack is a one-off: the failure to prevent is credits granted without payment. A subscription is a
 * *state* the organization is in, and the failure to prevent is **the entitlement moving when the payment did
 * not**. An organization upgraded to Pro on a declined card gets Pro features and pays nothing; one whose
 * plan silently changes under a 3-D Secure prompt it never completed is worse, because the product told it
 * the upgrade worked.
 *
 * So every assertion here reads `organization_entitlements` — the tier the product actually enforces — rather
 * than the HTTP status.
 *
 * `preview` is included and is deliberately the odd one out: it must never touch the provider or the
 * entitlement at all. It is a price quote, and a quote that mutates anything is a bug no status code reveals.
 */
import { expect, test } from 'playwright/test'

import {
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from '../harness/fixtures/interviews'
import { setServerBillingScenario } from '../harness/fakes/billing'
import type { E2EBillingScenario } from '../harness/fakes/billing'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'subscen' })
  // Deliberately *no* subscription yet — see `ensureSubscription` below.
  await harness.sql`
    insert into billing_seller_profiles (
      version, legal_name, public_business_address, establishment_country,
      support_email, statement_descriptor, country_allowlist, effective_at, created_by_user_id
    ) values (
      1, 'E2E Seller ApS', 'Testvej 1, 2100 København', 'DK',
      'billing@e2e.invalid', 'E2E BUILDERHUNT', '["DK"]'::jsonb, now(), ${harness.owner.userId!}
    )
    on conflict do nothing
  `
})

test.afterEach(async () => {
  await setServerBillingScenario(harness.redisPrefix, null).catch(() => undefined)
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

const DISCLOSURES = {
  renewal: true,
  amount: true,
  interval: true,
  cancellationRefundPolicy: true,
  creditExpiryNonTransferability: true,
  tax: true,
  total: true,
} as const

/**
 * **No subscription is seeded here, and that is the point.**
 *
 * `POST /api/billing/checkout/subscription` refuses with `409 subscription_exists` when the organization
 * already has one — correctly: you do not check out a second subscription, you change the one you have. So
 * this file covers the *first* purchase, against an organization with no plan, and its sibling
 * `billing-subscription-change-scenarios.spec.ts` covers change and preview against one that has a plan.
 *
 * They are two files rather than one because the starting states are genuinely opposite. The first attempt
 * kept them together and seeded lazily partway through; the checkout tests then failed on a 409 that was the
 * product being right, and once fixed, seeding after a checkout collided with the
 * `billing_customers_org_livemode_unique` row those checkouts had already created. Ordering inside one file
 * was load-bearing and invisible — a split says it out loud.
 */

/** The tier the product actually enforces — not what a response body claims. */
async function enforcedTier(): Promise<string | null> {
  const rows = await harness.sql<{ tier: string }[]>`
    select tier from organization_entitlements
    where organization_id = ${harness.organization.organizationId}
  `
  return rows[0]?.tier ?? null
}

async function subscriptionCheckout(scenario: E2EBillingScenario | null, idempotencyKey: string) {
  if (scenario) await setServerBillingScenario(harness.redisPrefix, scenario)
  const response = await harness.owner.api!.post('/api/billing/checkout/subscription', {
    data: {
      catalogKey: 'pro_annual',
      country: 'DK',
      disclosures: DISCLOSURES,
      successUrl: `${harness.baseURL}/settings/billing/return`,
      cancelUrl: `${harness.baseURL}/settings/billing`,
      idempotencyKey,
    },
  })
  return { status: response.status(), body: await response.text() }
}

test('success: a subscription checkout starts without moving the tier', async () => {
  /**
   * The baseline carries the real assertion, as in the pack file: starting a checkout is not paying for one.
   * A tier that moved here would give an organization Pro Annual for opening a page.
   */
  const before = await enforcedTier()
  const result = await subscriptionCheckout(null, 'sub-success')

  expect(result.status, result.body).toBeLessThan(400)
  const session = JSON.parse(result.body) as { checkoutUrl?: string }
  expect(session.checkoutUrl).toBeTruthy()
  expect(await enforcedTier(), 'opening a checkout must not change the plan').toBe(before)
})

for (const scenario of ['decline', 'timeout', 'sca_required', 'delayed'] as const) {
  test(`${scenario}: the enforced tier does not move`, async () => {
    /**
     * Four different provider outcomes, one required invariant. Two of them (`decline`, `timeout`) surface as
     * errors and two (`sca_required`, `delayed`) surface as *successes* — which is exactly why the assertion
     * cannot be the status code. A pending or unauthenticated payment is not a paid one, and the entitlement
     * table is the only place that distinction is enforceable.
     */
    const before = await enforcedTier()
    await subscriptionCheckout(scenario, `sub-${scenario}`)
    expect(await enforcedTier(), `${scenario} moved the enforced tier`).toBe(before)
  })
}
