/**
 * Credit-pack checkout through every provider scenario (plan 53, task 3).
 *
 * One file, one server, six scenarios — possible because of the Redis scenario channel proved in
 * `billing-scenario-channel.spec.ts`. The task originally scoped this as five files because a scenario used
 * to be fixed for the life of the server.
 *
 * ## What each scenario is actually testing
 *
 * The scenarios are not six flavours of "does it work". They are the six ways a payment provider fails a
 * customer, and each one has a different wrong answer the product could give:
 *
 * - `success` — the baseline. Without it the failures below prove nothing, because a route that always
 *   errored would pass every one of them.
 * - `sca_required` — the customer must complete 3-D Secure. The dangerous bug is treating this as success:
 *   the money has not moved, and a product that says it has will grant credits nobody paid for.
 * - `decline` and `timeout` — the provider throws before creating anything. Two distinct causes that must
 *   both end with *no local record*, because a checkout row for a payment that never existed is a
 *   reconciliation ghost someone chases later.
 * - `delayed` — created, but not terminal, and it never auto-settles. This is the normal case for real
 *   payment methods, and the wrong answer is to read "not failed" as "paid".
 * - `out_of_order` — the object is tagged so reconciliation lists come back reversed, simulating webhooks
 *   arriving in the wrong order. Checkout itself must be indifferent to it.
 *
 * ## The assertion that matters in all six
 *
 * Not the status code — the **ledger**. Every scenario checks `billing_credit_grants` (or its absence),
 * because the failure this whole surface exists to prevent is credits granted without payment, and that is
 * invisible from an HTTP response.
 */
import { expect, test } from 'playwright/test'

import {
  seedActiveSubscription,
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
  harness = await startInterviewHarness({ scope: 'billscen' })
  await seedActiveSubscription(harness, { tier: 'pro' })
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
  // Per test, not per file: a scenario left set would silently colour the next one, which is the exact
  // failure mode the channel was built to make impossible.
  await setServerBillingScenario(harness.redisPrefix, null).catch(() => undefined)
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

const CHECKOUT_BODY = {
  catalogKey: 'starter_300',
  country: 'DK',
  disclosures: {
    renewal: true,
    amount: true,
    interval: true,
    cancellationRefundPolicy: true,
    creditExpiryNonTransferability: true,
    tax: true,
    total: true,
  },
} as const

async function checkout(scenario: E2EBillingScenario | null, idempotencyKey: string) {
  if (scenario) await setServerBillingScenario(harness.redisPrefix, scenario)
  const response = await harness.owner.api!.post('/api/billing/checkout/credits', {
    data: {
      ...CHECKOUT_BODY,
      successUrl: `${harness.baseURL}/settings/billing/return`,
      cancelUrl: `${harness.baseURL}/settings/billing`,
      idempotencyKey,
    },
  })
  return { status: response.status(), body: await response.text() }
}

/**
 * Credits actually granted to this organization — the only number that matters below.
 *
 * `billing_credit_grants.original_units` is what a *purchase* writes. Two wrong guesses are recorded here
 * because the shape is not obvious: there is no `billing_credit_ledger` table — the ledger in this schema is
 * grants plus reservations plus allocations — and a grant's column is `original_units`/`remaining_units`
 * rather than `units`, which is what lets a grant be partly spent without losing what was bought.
 */
async function grantedCredits(): Promise<number> {
  const rows = await harness.sql<{ total: string | null }[]>`
    select coalesce(sum(original_units), 0)::text as total from billing_credit_grants
    where organization_id = ${harness.organization.organizationId}
  `
  return Number(rows[0]?.total ?? 0)
}

test('success: checkout is created and no credits are granted before payment', async () => {
  /**
   * The baseline, and it already carries a real assertion: starting a checkout must **not** move the ledger.
   * Credits arrive when the payment settles, not when the customer clicks buy — a product that granted them
   * here would hand out 300 credits to anyone who opened the checkout page and walked away.
   */
  const before = await grantedCredits()
  const result = await checkout(null, 'scen-success')

  expect(result.status, result.body).toBeLessThan(400)
  const session = JSON.parse(result.body) as { checkoutUrl?: string; status?: string }
  expect(session.checkoutUrl, 'a usable checkout URL came back').toBeTruthy()
  expect(session.status, 'and a status the caller can act on').toBeTruthy()
  expect(await grantedCredits(), 'opening a checkout must not grant credits').toBe(before)
})

test('sca_required: the customer must act, and the product must not call that paid', async () => {
  /**
   * 3-D Secure. The provider returns a session that needs further customer action — it has not failed, which
   * is precisely why it is dangerous: "not an error" read as "paid" is how credits get granted for money that
   * never arrived.
   */
  const before = await grantedCredits()
  const result = await checkout('sca_required', 'scen-sca')

  // Whatever the transport status, the ledger is the assertion.
  expect(await grantedCredits(), 'a checkout awaiting 3-D Secure must not grant credits').toBe(before)
  expect(result.body.toLowerCase()).not.toContain('"paid":true')
})

for (const scenario of ['decline', 'timeout'] as const) {
  test(`${scenario}: the provider throws, and nothing local is left behind`, async () => {
    /**
     * Two different causes, one required outcome. The provider throws before creating anything, so there must
     * be no local checkout row either — a row for a payment that never existed is a reconciliation ghost, and
     * someone spends an afternoon on it months later.
     */
    const before = await grantedCredits()
    const result = await checkout(scenario, `scen-${scenario}`)

    expect(result.status, `${scenario} should surface as an error: ${result.body}`).toBeGreaterThanOrEqual(400)
    expect(await grantedCredits(), `${scenario} must not grant credits`).toBe(before)

    const ghosts = await harness.sql<{ count: string }[]>`
      select count(*)::text as count from billing_checkout_attempts
      where organization_id = ${harness.organization.organizationId}
        and idempotency_key = ${`scen-${scenario}`}
    `
    expect(ghosts[0]?.count, `${scenario} left a local checkout row behind`).toBe('0')
  })
}

test('delayed: created but not terminal, and never silently settled', async () => {
  /**
   * The normal case for real payment methods — bank transfers, some cards — and the one most likely to be got
   * wrong, because the request *succeeds*. The provider creates the object in a non-terminal state and never
   * auto-settles; only a webhook does. So a successful HTTP response here must still leave the ledger alone.
   */
  const before = await grantedCredits()
  const result = await checkout('delayed', 'scen-delayed')

  expect(result.status, result.body).toBeLessThan(400)
  expect(await grantedCredits(), 'a pending payment is not a paid one').toBe(before)
})

test('out_of_order: reconciliation ordering does not leak into checkout', async () => {
  /**
   * This scenario tags the created object so reconciliation lists come back reversed — it models webhooks
   * arriving in the wrong order. Checkout itself must be completely indifferent: the same request, the same
   * answer, the same untouched ledger.
   */
  const before = await grantedCredits()
  const result = await checkout('out_of_order', 'scen-ooo')

  expect(result.status, result.body).toBeLessThan(400)
  expect(await grantedCredits()).toBe(before)
})

test('the same idempotency key is not a second checkout', async () => {
  /**
   * `duplicate` is not a create-time scenario — the fake provider's own note says it is exercised
   * structurally, by calling twice with the same key. A double-click must not become two payments.
   */
  const first = await checkout(null, 'scen-idem')
  const replay = await checkout(null, 'scen-idem')

  expect(first.status, first.body).toBeLessThan(400)
  expect(replay.status, replay.body).toBeLessThan(400)

  const rows = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from billing_checkout_attempts
    where organization_id = ${harness.organization.organizationId}
      and idempotency_key = 'scen-idem'
  `
  expect(rows[0]?.count, 'a replayed idempotency key created a second checkout').toBe('1')
})
