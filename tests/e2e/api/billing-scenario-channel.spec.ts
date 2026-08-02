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
})

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

test.fixme('the scenario key changes what the running server does', async () => {
  /**
   * **Written, runs, and currently blocked on a fixture — not on the code under test.**
   *
   * `POST /api/billing/checkout/credits` refuses with `503 billing_disabled` before it ever reaches the
   * provider, because `resolvePackCheckout` requires a row in `billing_seller_profiles` (seller identity,
   * country allowlist, per-catalog Stripe price ids) and no harness fixture seeds one. Two earlier attempts
   * are recorded in the assertions below so the next reader does not repeat them: the return URLs must be
   * same-origin, and the idempotency key must differ per call or the second request replays the first.
   *
   * So the scenario channel is **plumbed but unproven end to end**. What *is* verified: both sides build the
   * identical key (`${prefix}:e2e:billing-scenario`) from the same prefix the harness passes to the server as
   * `E2E_REDIS_PREFIX`; the shared-Redis arrangement is the one `src/shared/lib/rate-limit.ts` already relies
   * on across the same two processes; and with no key set, behaviour is unchanged across 288 tests.
   *
   * What is not verified is the last mile — that a written key actually reaches the fake provider. Until this
   * test runs, no scenario spec should be written on top of the channel, because the fallback to the
   * environment makes a dead channel indistinguishable from a working one with no scenario set.
   *
   * **Unblocking it is one fixture:** `seedBillingSellerProfile(harness, { countryAllowlist: ['DK'] })` plus
   * test price ids for `starter_300`. That is the next step, and it belongs in the harness rather than here.
   */
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
