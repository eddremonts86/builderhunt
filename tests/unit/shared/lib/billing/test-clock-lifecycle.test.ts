/**
 * Real Stripe Test Clock certification (plans/stripe-billing-platform/tasks.md §10 "Certify Stripe
 * sandbox and Test Clock lifecycle"; stripe-launch-register.md's release gate: "Monthly and annual
 * Test Clock lifecycles pass (creation, renewal, upgrade, downgrade, grace, cancellation,
 * leap/month-end anniversaries)"). Drives Stripe's real `test_helpers.test_clocks` API against the
 * real test-mode network — never mocked — to prove subscription TIME BEHAVIOR the rest of this
 * codebase's test suite cannot: every other billing test either uses the deterministic
 * `FakeBillingProvider` (whose renewal/period math is our own code, not Stripe's) or exercises
 * `RealBillingProvider` at a single instant (`real-provider.test.ts`). Only a Test Clock can prove a
 * REAL Stripe subscription actually renews, prorates an upgrade/downgrade, and goes `past_due` on a
 * declined renewal the way spec.md assumes.
 *
 * Skipped by default — needs STRIPE_SANDBOX_SECRET_KEY (a real sk_test_ key, deliberately separate
 * from STRIPE_SECRET_KEY now that .env holds the live key) AND an explicit opt-in, so `pnpm test`/CI
 * never silently makes real network calls. Each test clock is deleted in `afterEach` — deleting a
 * test clock cascades to every customer/subscription attached to it, so no manual Stripe Dashboard
 * cleanup is needed.
 *
 * Run with:  RUN_STRIPE_INTEGRATION_TESTS=1 pnpm vitest run src/shared/lib/billing/test-clock-lifecycle.test.ts
 */
import Stripe from 'stripe'
import { describe, expect, it, beforeAll, afterEach } from 'vitest'
import { SUBSCRIPTION_CATALOG } from '~/shared/lib/billing/catalog'

const rawSecretKey = process.env.STRIPE_SANDBOX_SECRET_KEY
const rawApiVersion = process.env.STRIPE_API_VERSION
const hasRealTestKey = Boolean(rawSecretKey?.startsWith('sk_test_') && rawApiVersion)
const shouldRun = hasRealTestKey && process.env.RUN_STRIPE_INTEGRATION_TESTS === '1'

const proMonthlyPriceId = SUBSCRIPTION_CATALOG.pro_monthly.stripePriceId.test
const proMaxMonthlyPriceId = SUBSCRIPTION_CATALOG.pro_max_monthly.stripePriceId.test

const DAY_SECONDS = 24 * 60 * 60

function unixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

describe.skipIf(!shouldRun)('Stripe Test Clock subscription lifecycle certification', () => {
  let stripe: Stripe
  const clockIds: string[] = []

  beforeAll(() => {
    if (!proMonthlyPriceId || !proMaxMonthlyPriceId) {
      throw new Error('catalog.ts is missing a test Price ID this suite needs — run pnpm stripe:provision --write first')
    }
    stripe = new Stripe(rawSecretKey!, { apiVersion: rawApiVersion as Stripe.LatestApiVersion })
  })

  afterEach(async () => {
    // Deleting a test clock cascades to every customer/subscription/invoice attached to it.
    await Promise.all(clockIds.splice(0).map((id) => stripe.testHelpers.testClocks.del(id).catch(() => undefined)))
  })

  /** Polls until the clock finishes advancing — Stripe processes the jump asynchronously. */
  async function advanceAndWait(clockId: string, frozenTime: number): Promise<void> {
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: frozenTime })
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await stripe.testHelpers.testClocks.retrieve(clockId)
      if (current.status === 'ready') return
      if (current.status === 'internal_failure') throw new Error(`Test clock ${clockId} entered internal_failure while advancing`)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error(`Test clock ${clockId} did not finish advancing within the polling budget`)
  }

  async function createClockCustomerWithCard(frozenTime: number, email: string): Promise<{ clockId: string; customerId: string }> {
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozenTime, name: `lifecycle-${email}` })
    clockIds.push(clock.id)
    const customer = await stripe.customers.create({ email, test_clock: clock.id })
    const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: paymentMethod.id } })
    return { clockId: clock.id, customerId: customer.id }
  }

  it('creates, renews, upgrades, downgrades, and cancels a real subscription under a Test Clock', async () => {
    const { clockId, customerId } = await createClockCustomerWithCard(unixSeconds('2026-01-15T00:00:00Z'), 'testclock-lifecycle@example.com')

    const created = await stripe.subscriptions.create({ customer: customerId, items: [{ price: proMonthlyPriceId! }] })
    expect(created.status).toBe('active')
    const firstItem = created.items.data[0]
    expect(firstItem.price.id).toBe(proMonthlyPriceId)

    // Advance past the first period end — proves a REAL renewal invoice gets created and paid,
    // not just that our own code believes a period rolled over.
    await advanceAndWait(clockId, firstItem.current_period_end + DAY_SECONDS)
    const renewed = await stripe.subscriptions.retrieve(created.id)
    expect(renewed.status).toBe('active')
    expect(renewed.items.data[0].current_period_end).toBeGreaterThan(firstItem.current_period_end)

    const invoices = await stripe.invoices.list({ subscription: created.id })
    expect(invoices.data.length).toBeGreaterThanOrEqual(2)
    expect(invoices.data.every((invoice) => invoice.status === 'paid')).toBe(true)

    // Upgrade — real proration, not the fake provider's arithmetic.
    const upgraded = await stripe.subscriptions.update(created.id, {
      items: [{ id: renewed.items.data[0].id, price: proMaxMonthlyPriceId! }],
      proration_behavior: 'create_prorations',
    })
    expect(upgraded.items.data[0].price.id).toBe(proMaxMonthlyPriceId)
    // `create_prorations` adds pending invoice items for the NEXT invoice rather than invoicing
    // immediately — the proration shows up on the upcoming invoice preview, not in already-finalized
    // invoices (there is no new finalized invoice yet at this point in the subscription's cycle).
    const upcoming = await stripe.invoices.createPreview({ subscription: created.id })
    expect(
      (upcoming.lines?.data ?? []).some((line) => line.parent?.subscription_item_details?.proration),
    ).toBe(true)

    // Downgrade back.
    const downgraded = await stripe.subscriptions.update(created.id, {
      items: [{ id: upgraded.items.data[0].id, price: proMonthlyPriceId! }],
      proration_behavior: 'none',
    })
    expect(downgraded.items.data[0].price.id).toBe(proMonthlyPriceId)

    const canceled = await stripe.subscriptions.cancel(created.id)
    expect(canceled.status).toBe('canceled')
  }, 180_000)

  it('renews correctly across a non-leap-year month-end anniversary (Jan 31 → Feb 28)', async () => {
    const { clockId, customerId } = await createClockCustomerWithCard(unixSeconds('2027-01-31T00:00:00Z'), 'testclock-monthend@example.com')
    const created = await stripe.subscriptions.create({ customer: customerId, items: [{ price: proMonthlyPriceId! }] })
    const firstItem = created.items.data[0]

    await advanceAndWait(clockId, firstItem.current_period_end + DAY_SECONDS)
    const renewed = await stripe.subscriptions.retrieve(created.id)
    expect(renewed.status).toBe('active')

    // The renewed period's START is the anniversary date itself (its END is the NEXT anniversary,
    // a month later) — a Jan-31 start anniversaries on Feb 28 in a non-leap year, not Mar 3 or any
    // other drifted date. This is Stripe's behavior, not ours, and this assertion is what actually
    // certifies it rather than assuming it.
    const anniversary = new Date(renewed.items.data[0].current_period_start * 1000)
    expect(anniversary.getUTCMonth()).toBe(1) // February
    expect([28, 29]).toContain(anniversary.getUTCDate())
  }, 120_000)

  it('goes past_due on a real declined renewal charge, proving the assumption seven-day dunning relies on', async () => {
    const { clockId, customerId } = await createClockCustomerWithCard(unixSeconds('2026-03-10T00:00:00Z'), 'testclock-decline@example.com')
    const created = await stripe.subscriptions.create({ customer: customerId, items: [{ price: proMonthlyPriceId! }] })
    expect(created.status).toBe('active') // first invoice succeeded on the good card

    // Swap in Stripe's official `pm_card_authenticationRequired` test PaymentMethod — this account
    // rejects raw card numbers via the Tokens API entirely (confirmed by direct probe: "raw card
    // data APIs" are disabled), so a real card number is not an option here. `attach` itself never
    // charges anything, so it succeeds regardless of this PM's decline behavior; only a later
    // off-session CONFIRMATION requires authentication and fails to auto-complete — exactly the
    // renewal charge this test needs to fail, not the initial one.
    const decliningMethod = await stripe.paymentMethods.attach('pm_card_authenticationRequired', { customer: customerId })
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: decliningMethod.id } })

    const firstItem = created.items.data[0]
    await advanceAndWait(clockId, firstItem.current_period_end + DAY_SECONDS)

    const afterFailedRenewal = await stripe.subscriptions.retrieve(created.id)
    expect(['past_due', 'unpaid']).toContain(afterFailedRenewal.status)
  }, 120_000)
})
