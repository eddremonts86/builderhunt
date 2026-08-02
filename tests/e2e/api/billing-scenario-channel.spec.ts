/**
 * Proof that a billing scenario set mid-run reaches the app server (plan 53, task 3 — prerequisite).
 *
 * This file exists to answer one question, and only that question: **does writing the scenario key actually
 * change what the running server does?**
 *
 * It needs its own spec because the failure it guards against is invisible. `currentE2EDefaultScenario()` in
 * `src/shared/lib/billing/stripe-provider.ts` reads Redis and *falls back to the environment* when the key is
 * absent. So a wrong key name, a mismatched prefix, or a Redis the server cannot reach all produce exactly the
 * same observable behaviour as a correct implementation with no scenario set: everything passes. A suite that
 * only ever asserted "no key → normal behaviour" would stay green while the channel was completely dead, and
 * every scenario test written on top of it would silently assert against `success`.
 *
 * Hence the shape below: the *same request*, twice, differing only by the key. If both answers are the same,
 * the channel is not working, whatever the status codes happen to be.
 */
import { expect, test } from 'playwright/test'

import {
  grantInterviewCredits,
  seedActiveSubscription,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from '../harness/fixtures/interviews'
import { setServerBillingScenario } from '../harness/fakes/billing'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'scen' })
  await seedActiveSubscription(harness, { tier: 'pro' })
  await grantInterviewCredits(harness, 100)
  await seedSellerProfile()
})

/**
 * The row without which every pack checkout answers `503 billing_disabled`.
 *
 * `resolvePackCheckout` refuses before it reaches the provider unless a seller profile exists and its
 * `country_allowlist` contains the requested country — correct, because selling into a country you have not
 * registered to sell in is a tax problem, not a feature flag. No harness fixture seeded one, which is what
 * blocked the first version of this spec.
 *
 * Inline here rather than in the harness on purpose: it is one insert and this is the only spec that needs it
 * today. The billing scenario matrix will need it too, and that is the moment to lift it into
 * `tests/e2e/harness/fixtures/`, with a caller to justify the shape.
 */
async function seedSellerProfile(): Promise<void> {
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
}

test.afterAll(async () => {
  // Never leave a scenario pinned for whatever runs next in this worker.
  await setServerBillingScenario(harness.redisPrefix, null).catch(() => undefined)
  await stopInterviewHarness(harness)
})

/** A body the schema accepts, lifted from `tests/unit/routes/api/billing/checkout/credits.test.ts`. */
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

/**
 * Return URLs must be same-origin — the route refuses anything else with `invalid_url`, which is right: a
 * checkout return URL is where a paying customer lands after a payment, and an attacker-chosen one is a
 * phishing hop with the app's own credibility behind it. So they are built from the worker's base URL rather
 * than hard-coded, unlike the unit test this body came from, which never leaves the process.
 */
const returnUrls = () => ({
  successUrl: `${harness.baseURL}/settings/billing/return`,
  cancelUrl: `${harness.baseURL}/settings/billing`,
})

async function checkout(idempotencyKey: string) {
  const response = await harness.owner.api!.post('/api/billing/checkout/credits', {
    data: { ...CHECKOUT_BODY, ...returnUrls(), idempotencyKey },
  })
  return { status: response.status(), body: await response.text() }
}

test('the scenario key changes what the running server does', async () => {
  /**
   * `decline` makes the fake provider throw `BillingProviderError` before creating anything, so the route
   * turns it into a `provider_error` (502). `success` — the absence of a key — completes.
   *
   * A fresh idempotency key per call, because a replayed key would return the first call's stored answer and
   * the second assertion would be reading a cached success rather than a live one.
   */
  const before = await checkout('scen-baseline')
  expect(before.status, `baseline checkout failed: ${before.body}`).toBeLessThan(400)

  await setServerBillingScenario(harness.redisPrefix, 'decline')
  const declined = await checkout('scen-declined')

  expect(
    declined.status,
    `the scenario key had no effect — same answer with and without it (${declined.body})`,
  ).not.toBe(before.status)
  expect(declined.status).toBeGreaterThanOrEqual(400)

  // ...and clearing it hands control back, so the channel is a switch rather than a one-way door.
  await setServerBillingScenario(harness.redisPrefix, null)
  const restored = await checkout('scen-restored')
  expect(restored.status, `clearing the key did not restore normal behaviour: ${restored.body}`)
    .toBe(before.status)
})
