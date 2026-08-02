/**
 * Changing and previewing an existing subscription, through the provider scenarios (plan 53, task 3).
 *
 * The other half of `billing-subscription-scenarios.spec.ts`, split from it because the starting state is the
 * opposite: this organization *has* a plan, and the question is whether a failed payment can move it.
 *
 * The failure to prevent is the entitlement moving when the payment did not. An organization upgraded on a
 * declined card gets the product free; one dropped to a lower tier by a failed change paid and lost access.
 * Both are invisible from a status code, so every assertion reads `organization_entitlements` — the tier the
 * product actually enforces.
 *
 * `preview` is the odd one out and worth its own test precisely because it looks harmless: it is a price
 * quote, and a quote that touches the provider or the entitlement is a bug whose response body still looks
 * correct.
 */
import { expect, test } from 'playwright/test'

import {
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
  harness = await startInterviewHarness({ scope: 'subchg' })
  await seedActiveSubscription(harness, { tier: 'pro' })
})

test.afterEach(async () => {
  await setServerBillingScenario(harness.redisPrefix, null).catch(() => undefined)
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

/** The tier the product actually enforces — not what a response body claims. */
async function enforcedTier(): Promise<string | null> {
  const rows = await harness.sql<{ tier: string }[]>`
    select tier from organization_entitlements
    where organization_id = ${harness.organization.organizationId}
  `
  return rows[0]?.tier ?? null
}

/**
 * **Both tests below are `fixme`, and the reason is a fixture gap rather than a product defect.**
 *
 * `seedActiveSubscription` writes the *database* rows — `organization_entitlements`, the subscription
 * record — but never creates a subscription inside the billing provider. Under `E2E_MODE` that provider is
 * the in-memory fake, which therefore has never heard of this organization's subscription. So any route that
 * asks the provider to act on it (`preview`, `change`) fails at the provider lookup, and
 * `POST /api/billing/subscription/preview` answers `500 Failed to preview subscription change` with **no
 * scenario set at all**.
 *
 * That matters more than it looks. The `change` test below asserts `>= 400`, and a 500 satisfies it — so it
 * passes while proving nothing about declines. That is the false green this whole task is built to avoid, and
 * it is why these are marked rather than left running: a test that passes for the wrong reason is worse than
 * one that is visibly pending.
 *
 * A correction to an earlier reading of this, kept because the wrong version is the tempting one: preview does
 * **not** route through `changeSubscription`. The provider has its own `previewSubscriptionChange`, which the
 * E2E subclass does not scenario-default at all — only `createCheckoutSession`, `createPaymentIntent` and
 * `changeSubscription` carry a scenario. So preview's 500 has nothing to do with `decline`; it is the fixture
 * gap alone, in both cases.
 *
 * **Unblocking is one fixture change:** `seedActiveSubscription` should route through the provider (or the
 * spec should create the subscription via `POST /api/billing/checkout/subscription` and settle it) so the DB
 * and the provider agree. The checkout scenarios in `billing-subscription-scenarios.spec.ts` and
 * `billing-checkout-scenarios.spec.ts` need no such thing — they create their objects through the provider in
 * the first place, which is why they are green.
 */
test.fixme('preview is a quote: it does not move the entitlement', async () => {
  const before = await enforcedTier()
  const response = await harness.owner.api!.post('/api/billing/subscription/preview', {
    data: { newCatalogKey: 'pro_annual' },
  })

  expect(response.status(), await response.text()).toBeLessThan(400)
  expect(await enforcedTier(), 'a price quote changed the plan').toBe(before)
})

test.fixme('change: a declined upgrade leaves the organization on the plan it paid for', async () => {
  /**
   * The most expensive failure in this area. An organization that clicks upgrade, has its card declined, and
   * lands on the higher tier anyway is being given the product free; one dropped to a lower tier by a failed
   * change paid and lost access.
   *
   * Asserting a 4xx is not enough on its own — see the note above — so when the fixture is fixed this should
   * assert the *decline* status specifically, not merely "an error".
   */
  const before = await enforcedTier()
  await setServerBillingScenario(harness.redisPrefix, 'decline')

  const response = await harness.owner.api!.post('/api/billing/subscription/change', {
    data: {
      newCatalogKey: 'pro_annual',
      fingerprint: 'e2e-fingerprint',
      idempotencyKey: 'sub-change-decline',
    },
  })
  const body = await response.text()

  expect(response.status(), `a declined change must not succeed: ${body}`).toBeGreaterThanOrEqual(400)
  expect(response.status(), 'and must fail as a decline, not as a 500').toBeLessThan(500)
  expect(await enforcedTier(), 'a declined change moved the enforced tier').toBe(before)
})
