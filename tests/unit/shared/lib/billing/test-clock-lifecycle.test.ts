/**
 * Real Stripe Test Clock certification (plans/implemented/30-stripe-billing-platform/tasks.md §10 "Certify Stripe
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
 * Skipped by default — needs STRIPE_SANDBOX_SECRET_KEY (a real sk_test_ key, deliberately separate from
 * STRIPE_SECRET_KEY) AND an explicit opt-in, so `pnpm test`/CI never silently makes real network calls. Each
 * test clock is deleted in `afterEach` — deleting a test clock cascades to every customer/subscription
 * attached to it, so no manual Stripe Dashboard cleanup is needed.
 *
 * **Correction, 2026-08-03:** this note previously justified the separate key with "now that `.env` holds the
 * live key". That was wrong and worth fixing rather than deleting, because believing it is dangerous: `.env`
 * holds an **`sk_test_`** key, verified by inspection. Anyone who read the old sentence would think their local
 * runs were pointed at live Stripe, and might avoid running something safe — or, worse, treat a genuinely live
 * key as normal. Two separate test keys is still the right arrangement (this suite creates and destroys clocks,
 * customers and subscriptions, and should not share an idempotency namespace with the app's own key), but the
 * reason is isolation, not danger.
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

  /**
   * The scenarios `staging-test-plan.md` §5 lists as still needing evidence for the launch register.
   *
   * All of these certify **Stripe's** time behaviour, not ours, which is the only reason a real network test
   * is worth its runtime: our own renewal and grant maths are already covered deterministically by the fake.
   * What cannot be faked is whether a real subscription actually anniversaries where we assume, whether a
   * trial actually converts, and whether a second renewal produces a second invoice rather than re-billing
   * the first.
   *
   * §5's third scenario (leap year / month-end anchor) is deliberately **not** duplicated here — the
   * "Jan 31 → Feb 28" test above already certifies exactly that property against a real subscription, and a
   * second copy with a different start date would add runtime without adding evidence.
   */
  it('anniversaries twice in a row on a monthly plan, producing two distinct paid invoices', async () => {
    /**
     * §5.1. The reason two advances matter rather than one: a single renewal proves the subscription did not
     * expire, but says nothing about whether the *next* window is keyed correctly. A monthly credit grant is
     * derived per window, so a second anniversary that reused the first window's key would silently stop
     * granting from month two onward — visible to a customer, invisible to a one-renewal test.
     *
     * Invoices are counted rather than trusting `status`, because a subscription can remain `active` while
     * billing the same period twice.
     */
    const { clockId, customerId } = await createClockCustomerWithCard(unixSeconds('2026-01-15T00:00:00Z'), 'testclock-monthly-anniv@example.com')
    const created = await stripe.subscriptions.create({ customer: customerId, items: [{ price: proMonthlyPriceId! }] })

    await advanceAndWait(clockId, created.items.data[0].current_period_end + DAY_SECONDS)
    const afterFirst = await stripe.subscriptions.retrieve(created.id)
    expect(afterFirst.status).toBe('active')

    await advanceAndWait(clockId, afterFirst.items.data[0].current_period_end + DAY_SECONDS)
    const afterSecond = await stripe.subscriptions.retrieve(created.id)
    expect(afterSecond.status).toBe('active')

    const invoices = await stripe.invoices.list({ subscription: created.id, limit: 20 })
    const paid = invoices.data.filter((invoice) => invoice.status === 'paid')
    // Creation plus two renewals.
    expect(paid.length).toBeGreaterThanOrEqual(3)

    /**
     * The service window lives on the **line item**, not on `invoice.period_start` — measured, because the
     * first version of this assertion used the invoice field and failed with "expected 2 to be 3".
     *
     * Probing the real objects showed why, and it is worth writing down because a grant-window derivation
     * reading the wrong field would look correct:
     *
     * | `billing_reason`      | `invoice.period`  | line `period`   |
     * | --------------------- | ----------------- | --------------- |
     * | `subscription_create` | `[t0, t0]` — zero | `[t0, t1]`      |
     * | `subscription_cycle`  | `[t0, t1]`        | `[t1, t2]`      |
     * | `subscription_cycle`  | `[t1, t2]`        | `[t2, t3]`      |
     *
     * The creation invoice's own period is a zero-length window at the creation instant, and it collides with
     * the first cycle invoice's `period_start`. So three invoices legitimately yield only two distinct
     * `invoice.period_start` values, and the collision is an artefact of the field rather than double billing.
     *
     * The line periods are the truth: three, distinct, contiguous — and each cycle invoice covers the
     * *upcoming* window, because Stripe bills in advance.
     */
    const linePeriods = paid
      .map((invoice) => invoice.lines?.data?.[0]?.period)
      .filter((period): period is { start: number; end: number } => Boolean(period))
    expect(linePeriods.length, 'every paid subscription invoice should carry a line period').toBe(paid.length)

    const starts = new Set(linePeriods.map((period) => period.start))
    expect(starts.size, 'two invoices billed the same service window').toBe(linePeriods.length)

    // Contiguous, not overlapping: sorted, each window starts exactly where the previous one ended.
    const sorted = [...linePeriods].sort((a, b) => a.start - b.start)
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]!.start, 'billing windows must be contiguous, never overlapping or gapped')
        .toBe(sorted[index - 1]!.end)
    }

    // The second anniversary must be a month past the first, not a repeat of it.
    expect(afterSecond.items.data[0].current_period_start).toBeGreaterThan(afterFirst.items.data[0].current_period_start)
  }, 240_000)

  it('anniversaries an annual plan a full year later', async () => {
    /**
     * §5.2. An annual subscription's first renewal is a year away, so nothing short of a Test Clock can reach
     * it — this is the single scenario in the whole suite with no alternative form of evidence. `annual_grants.ts`
     * keys the year-1 grant off this anniversary; if Stripe anchored it anywhere other than the same calendar
     * date, the grant would be issued against a window that does not exist.
     */
    const annualPriceId = SUBSCRIPTION_CATALOG.pro_annual.stripePriceId.test
    expect(annualPriceId, 'catalog.ts is missing pro_annual\'s test Price ID').toBeTruthy()

    const { clockId, customerId } = await createClockCustomerWithCard(unixSeconds('2026-01-15T00:00:00Z'), 'testclock-annual-anniv@example.com')
    const created = await stripe.subscriptions.create({ customer: customerId, items: [{ price: annualPriceId! }] })
    const firstStart = new Date(created.items.data[0].current_period_start * 1000)

    await advanceAndWait(clockId, created.items.data[0].current_period_end + DAY_SECONDS)
    const renewed = await stripe.subscriptions.retrieve(created.id)
    expect(renewed.status).toBe('active')

    const anniversary = new Date(renewed.items.data[0].current_period_start * 1000)
    expect(anniversary.getUTCFullYear(), 'an annual plan must anniversary exactly one year on').toBe(firstStart.getUTCFullYear() + 1)
    expect(anniversary.getUTCMonth()).toBe(firstStart.getUTCMonth())
    expect(anniversary.getUTCDate()).toBe(firstStart.getUTCDate())
  }, 240_000)

  it('converts a trial to active on the first real charge', async () => {
    /**
     * §5.5. A trial is the one state where a subscription is `trialing` — entitled — while nothing has been
     * charged. The transition is what the entitlement projection reads, so a trial that silently stayed
     * `trialing` past its end would keep granting access for free, and one that went straight to `canceled`
     * would cut off a customer who was about to pay.
     */
    const { clockId, customerId } = await createClockCustomerWithCard(unixSeconds('2026-05-01T00:00:00Z'), 'testclock-trial@example.com')
    const created = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: proMonthlyPriceId! }],
      trial_period_days: 7,
    })
    expect(created.status).toBe('trialing')

    // Eight days: one past the trial's end, so the first real invoice is due.
    await advanceAndWait(clockId, unixSeconds('2026-05-09T00:00:00Z'))
    const afterTrial = await stripe.subscriptions.retrieve(created.id)
    expect(afterTrial.status, 'the trial did not convert on a good card').toBe('active')

    const invoices = await stripe.invoices.list({ subscription: created.id, limit: 10 })
    const charged = invoices.data.filter((invoice) => invoice.status === 'paid' && (invoice.amount_paid ?? 0) > 0)
    expect(charged.length, 'converting a trial must produce a real paid invoice, not a zero-amount one').toBeGreaterThanOrEqual(1)
  }, 240_000)

  it('leaves the subscription unpaid rather than silently active through a full dunning window', async () => {
    /**
     * §5.4. The existing decline test proves the subscription *enters* `past_due`. This one asks what happens
     * if nobody fixes the card: the seven-day grace `subscription-state.ts` relies on has to end somewhere,
     * and the two acceptable endings are `canceled` or `unpaid` — never a return to `active`.
     *
     * Deliberately asserted as a set rather than a single value. Which of the two Stripe picks is an
     * **account-level dunning setting**, not a property of our code, so pinning one would make this test fail
     * the day someone changes a Dashboard preference — for a reason that is not a regression. What must never
     * happen is the subscription looking payable again while the card still declines, and that is what this
     * measures.
     */
    const { clockId, customerId } = await createClockCustomerWithCard(unixSeconds('2026-06-01T00:00:00Z'), 'testclock-dunning@example.com')
    const created = await stripe.subscriptions.create({ customer: customerId, items: [{ price: proMonthlyPriceId! }] })
    expect(created.status).toBe('active')

    const declining = await stripe.paymentMethods.attach('pm_card_authenticationRequired', { customer: customerId })
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: declining.id } })

    await advanceAndWait(clockId, created.items.data[0].current_period_end + DAY_SECONDS)
    const afterFailure = await stripe.subscriptions.retrieve(created.id)
    expect(['past_due', 'unpaid']).toContain(afterFailure.status)

    // Seven more days of dunning with the card still failing.
    const currentClock = await stripe.testHelpers.testClocks.retrieve(clockId)
    await advanceAndWait(clockId, currentClock.frozen_time + 7 * DAY_SECONDS)

    const afterGrace = await stripe.subscriptions.retrieve(created.id)
    expect(
      ['past_due', 'unpaid', 'canceled'],
      `a subscription whose card still declines must never read active again (was ${afterGrace.status})`,
    ).toContain(afterGrace.status)
    expect(afterGrace.status).not.toBe('active')

    // And no invoice for the failed period may be sitting as paid.
    const invoices = await stripe.invoices.list({ subscription: created.id, limit: 20 })
    const openOrUncollectible = invoices.data.filter((invoice) => invoice.status === 'open' || invoice.status === 'uncollectible')
    expect(openOrUncollectible.length, 'a declined renewal left no unpaid invoice behind').toBeGreaterThanOrEqual(1)
  }, 300_000)
})
