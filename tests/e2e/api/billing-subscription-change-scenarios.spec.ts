/**
 * Changing, previewing and cancelling an existing subscription, through the provider scenarios (plan 53, task 3).
 *
 * The other half of `billing-subscription-scenarios.spec.ts`, split from it because the starting state is the
 * opposite: this organization *has* a plan, and the question is whether a failed payment can move it.
 *
 * The failure to prevent is the entitlement moving when the payment did not. An organization upgraded on a
 * declined card gets the product free; one dropped to a lower tier by a failed change paid and lost access.
 * Both are invisible from a status code, so every assertion below reads `billing_subscriptions.catalog_key` —
 * the plan the product actually bills and enforces — and, where credits are involved, the grant ledger.
 *
 * `preview` is the odd one out and worth its own test precisely because it looks harmless: it is a price quote,
 * and a quote that moves the plan is a bug whose response body still looks correct.
 *
 * ## Two of these were `fixme`, and the fix was a fixture, not a product change
 *
 * `seedActiveSubscription` wrote our own rows with an invented `stripe_subscription_id` the in-memory fake
 * provider had never heard of, so `preview` and `cancel` answered **500** at the provider lookup. Worse than a
 * gap: the declined-change test asserted `>= 400`, which a 500 satisfies, so it passed while proving nothing
 * about declines. The seed now also tells the provider, over `POST /api/e2e/billing-provider`.
 *
 * A correction kept because the wrong version is the tempting one: preview does **not** route through
 * `changeSubscription`. The provider has its own `previewSubscriptionChange`, and the E2E subclass
 * scenario-defaults only `createCheckoutSession`, `createPaymentIntent` and `changeSubscription`. So preview's
 * old 500 had nothing to do with `decline` — it was the fixture in both cases.
 *
 * ## Order is load-bearing
 *
 * Serial, and the mutating tests come last on purpose: a successful change rewrites `catalog_key`, which
 * invalidates every fingerprint taken before it, and cancelling sets `cancel_at_period_end`, after which
 * `findFullActiveBillingSubscription` no longer describes the state the earlier tests assume.
 */
import { expect, test } from 'playwright/test'

import {
  seedActiveSubscription,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
  type SeededSubscription,
} from '../harness/fixtures/interviews'
import { setServerBillingScenario } from '../harness/fakes/billing'

let harness: InterviewHarness
let subscription: SeededSubscription

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'subchg' })
  subscription = await seedActiveSubscription(harness, { tier: 'pro', interval: 'monthly' })
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

/** The plan being billed. Sharper than the tier for same-tier interval moves, which change this and not that. */
async function billedCatalogKey(): Promise<string | null> {
  const rows = await harness.sql<{ catalog_key: string }[]>`
    select catalog_key from billing_subscriptions
    where organization_id = ${harness.organization.organizationId}
      and stripe_subscription_id = ${subscription.stripeSubscriptionId}
  `
  return rows[0]?.catalog_key ?? null
}

/** Credits granted specifically by an upgrade proration — never by a checkout. */
async function upgradeDeltaGrants(): Promise<number> {
  const rows = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from billing_credit_grants
    where organization_id = ${harness.organization.organizationId}
      and source = 'subscription_upgrade_delta'
  `
  return Number(rows[0]?.count ?? 0)
}

interface Preview {
  currentCatalogKey: string
  newCatalogKey: string
  direction: string
  timing: string
  fingerprint: string
}

async function preview(newCatalogKey: string) {
  const response = await harness.owner.api!.post('/api/billing/subscription/preview', { data: { newCatalogKey } })
  return { status: response.status(), body: await response.text() }
}

async function change(data: { newCatalogKey: string; fingerprint: string; idempotencyKey: string }) {
  const response = await harness.owner.api!.post('/api/billing/subscription/change', { data })
  return { status: response.status(), body: await response.text() }
}

test('preview is a quote: it names the change, hands back a fingerprint, and moves nothing', async () => {
  /**
   * Three properties in one request, because they are only meaningful together. A quote that fails to classify
   * the change is useless to the UI; one with no fingerprint cannot protect the confirmation that follows; and
   * one that *applies* the change is the bug this test exists for — the response body would look identical.
   */
  const tierBefore = await enforcedTier()
  const planBefore = await billedCatalogKey()

  const result = await preview('pro_max_monthly')
  expect(result.status, result.body).toBe(200)
  const quote = JSON.parse(result.body) as Preview

  expect(quote.currentCatalogKey).toBe('pro_monthly')
  expect(quote.newCatalogKey).toBe('pro_max_monthly')
  expect(quote.direction, 'pro -> pro_max is an upgrade').toBe('upgrade')
  expect(quote.timing, 'and an upgrade applies immediately, not at period end').toBe('immediate')
  expect(quote.fingerprint, 'without a fingerprint the confirmation cannot be protected').toContain(
    subscription.stripeSubscriptionId,
  )

  expect(await enforcedTier(), 'a price quote changed the enforced tier').toBe(tierBefore)
  expect(await billedCatalogKey(), 'a price quote changed the billed plan').toBe(planBefore)
})

test('a stale fingerprint is refused with 409 rather than applied', async () => {
  /**
   * The anti-stale-preview guard. The window it closes: an owner opens the upgrade dialog, a renewal webhook
   * moves the subscription underneath them, and they confirm a quote computed against state that no longer
   * exists. The fingerprint is `${subscriptionId}:${providerSyncedAt}` — so a forged one that names the right
   * subscription at the wrong instant must still be rejected, which is what this sends.
   */
  const planBefore = await billedCatalogKey()
  const result = await change({
    newCatalogKey: 'pro_max_monthly',
    fingerprint: `${subscription.stripeSubscriptionId}:1999-01-01T00:00:00.000Z`,
    idempotencyKey: 'sub-change-stale',
  })

  expect(result.status, result.body).toBe(409)
  expect(JSON.parse(result.body)).toMatchObject({ code: 'stale_preview' })
  expect(await billedCatalogKey(), 'a stale confirmation moved the billed plan').toBe(planBefore)
})

for (const scenario of ['decline', 'timeout'] as const) {
  test(`${scenario}: the organization stays on the plan it paid for`, async () => {
    /**
     * The most expensive failure in this area. An organization that clicks upgrade, has its card declined, and
     * lands on the higher tier anyway is being given the product free.
     *
     * Asserting a 4xx is not enough — a 500 is a 4xx-passing accident, which is how this test used to pass for
     * the wrong reason. So the status is pinned to **402 `payment_failed`** exactly: a decline is a payment
     * outcome the client can act on, not a server error.
     *
     * The fingerprint is taken fresh inside the test rather than reused from the one above, because a stale
     * fingerprint would short-circuit at 409 and never reach the provider at all — the test would then prove
     * the guard works, not that a decline is safe.
     */
    const quote = JSON.parse((await preview('pro_max_monthly')).body) as Preview
    const planBefore = await billedCatalogKey()
    const tierBefore = await enforcedTier()

    await setServerBillingScenario(harness.redisPrefix, scenario)
    const result = await change({
      newCatalogKey: 'pro_max_monthly',
      fingerprint: quote.fingerprint,
      idempotencyKey: `sub-change-${scenario}`,
    })

    expect(result.status, `a ${scenario} must fail as a payment outcome, not a 500: ${result.body}`).toBe(402)
    expect(JSON.parse(result.body)).toMatchObject({ code: 'payment_failed' })
    expect(await billedCatalogKey(), `a ${scenario} moved the billed plan`).toBe(planBefore)
    expect(await enforcedTier(), `a ${scenario} moved the enforced tier`).toBe(tierBefore)
    expect(await upgradeDeltaGrants(), `a ${scenario} granted upgrade credits`).toBe(0)
  })
}

test('sca_required is not success: the plan does not move until the customer authenticates', async () => {
  /**
   * The subtlest of the six, and the one worth the most. 3-D Secure does not throw — the provider returns a
   * subscription in `incomplete`, so a product that checks only for an exception treats an unauthenticated
   * payment as a completed one. `changeSubscription`'s own comment is explicit that a non-`active` result is
   * "not yet paid"; this is the assertion that keeps it true.
   */
  const quote = JSON.parse((await preview('pro_max_monthly')).body) as Preview
  const planBefore = await billedCatalogKey()

  await setServerBillingScenario(harness.redisPrefix, 'sca_required')
  const result = await change({
    newCatalogKey: 'pro_max_monthly',
    fingerprint: quote.fingerprint,
    idempotencyKey: 'sub-change-sca',
  })

  expect(result.status, result.body).toBe(402)
  expect(JSON.parse(result.body), 'an SCA-pending change is "requires_action", not "payment_failed"').toMatchObject({
    code: 'requires_action',
  })
  expect(await billedCatalogKey(), 'an unauthenticated payment moved the billed plan').toBe(planBefore)
  expect(await upgradeDeltaGrants(), 'an unauthenticated payment granted upgrade credits').toBe(0)
})

test('preview then change applies the upgrade once, and a replay is not a second grant', async () => {
  /**
   * The success path, and the only test here that is *allowed* to move the plan — which is why it runs after
   * the failures: it invalidates every fingerprint taken before it.
   *
   * The replay is the second half and the more interesting one. A double-clicked confirm, or a client retrying
   * a response it never saw, must not grant the proration credits twice. `changeSubscription` handles this by
   * detecting that the subscription already sits on the target key and reading the delta back from the ledger
   * by idempotency key instead of recomputing it — recomputing would see old tier === new tier and report 0
   * for what was a real grant.
   */
  const quote = JSON.parse((await preview('pro_max_monthly')).body) as Preview
  const tierBeforeChange = await enforcedTier()

  const first = await change({
    newCatalogKey: 'pro_max_monthly',
    fingerprint: quote.fingerprint,
    idempotencyKey: 'sub-change-applied',
  })
  expect(first.status, first.body).toBe(200)
  const applied = JSON.parse(first.body) as { applied: string; newCatalogKey: string; creditDelta: number }
  expect(applied.applied).toBe('immediate')
  expect(applied.newCatalogKey).toBe('pro_max_monthly')
  expect(applied.creditDelta, 'an upgrade mid-period owes the difference in monthly credits').toBeGreaterThan(0)

  expect(await billedCatalogKey(), 'a successful change must actually move the billed plan').toBe('pro_max_monthly')

  /**
   * And the entitlement deliberately does **not** move yet — asserted rather than assumed, because the
   * asymmetry is easy to mistake for a bug in either direction.
   *
   * `organization_entitlements` is written only by `projectSubscriptionEntitlement`, and its only callers are
   * the three webhook handlers. Stripe is authoritative for the fields a projection needs — status, period
   * bounds, seat limit — so the request path records the plan it just bought and lets
   * `customer.subscription.updated` publish the entitlement seconds later. Every local write on this path is
   * documented as an "optimistic local mirror" for the same reason.
   *
   * Pinning it here means a future change that starts writing entitlements from the request path fails this
   * line and has to argue for itself, rather than quietly introducing a second writer that can disagree with
   * the webhook.
   */
  expect(await enforcedTier(), 'the entitlement is the webhook\'s to publish, not this route\'s').toBe(tierBeforeChange)

  const grantsAfterFirst = await upgradeDeltaGrants()
  expect(grantsAfterFirst).toBe(1)

  const replay = await change({
    newCatalogKey: 'pro_max_monthly',
    fingerprint: quote.fingerprint,
    idempotencyKey: 'sub-change-applied',
  })
  expect(replay.status, replay.body).toBe(200)
  const replayed = JSON.parse(replay.body) as { creditDelta: number }
  expect(replayed.creditDelta, 'the replay must report the original grant, not zero').toBe(applied.creditDelta)
  expect(await upgradeDeltaGrants(), 'a replayed confirmation granted the proration twice').toBe(grantsAfterFirst)
})

test.describe('POST /api/billing/subscription/cancel', () => {
  test('schedules cancellation for the period end, and never cancels immediately', async () => {
    /**
     * The route reads no body at all — spec.md forbids immediate cancellation, so there is deliberately no
     * `atPeriodEnd: false` to pass. A body asking for one is sent anyway: it must be ignored rather than
     * honoured, and the subscription must still be `active` afterwards. An organization that paid through the
     * end of its period keeps what it paid for.
     */
    const response = await harness.owner.api!.post('/api/billing/subscription/cancel', {
      data: { atPeriodEnd: false },
    })
    const body = await response.text()
    expect(response.status(), body).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ cancelAtPeriodEnd: true })

    const [row] = await harness.sql<{ cancel_at_period_end: boolean; stripe_status: string }[]>`
      select cancel_at_period_end, stripe_status from billing_subscriptions
      where stripe_subscription_id = ${subscription.stripeSubscriptionId}
    `
    expect(row.cancel_at_period_end, 'cancellation must be recorded, not just reported').toBe(true)
    expect(row.stripe_status, 'a scheduled cancellation must not end the subscription now').toBe('active')
  })

  test('a second cancellation is a no-op, not an error', async () => {
    // A duplicate click is the normal case. The service's own contract: "a second call while already scheduled
    // is a no-op, not an error" — and it must not reach the provider again either.
    const response = await harness.owner.api!.post('/api/billing/subscription/cancel', { data: {} })
    expect(response.status(), await response.text()).toBe(200)

    const [row] = await harness.sql<{ cancel_at_period_end: boolean }[]>`
      select cancel_at_period_end from billing_subscriptions
      where stripe_subscription_id = ${subscription.stripeSubscriptionId}
    `
    expect(row.cancel_at_period_end).toBe(true)
  })
})
