/**
 * Denmark-canary certification, split by what test mode can actually prove.
 *
 * `plans/implemented/30-stripe-billing-platform/tasks.md` §15 "Run live Denmark canary and staged rollout" asks for
 * nine observations: a successful charge, an invoice, a tax result, a credit/entitlement grant, a refund,
 * payout/FX facts, reconciliation, rollback, and EU countries staying disabled. Treated as one atomic task it is
 * blocked on `sk_live_` and a real volunteer customer — which is phase-5 — and that blocked seven observations
 * that have nothing to do with real money behind one that does.
 *
 * This suite certifies the Stripe-side observations against the **real test-mode API**, never a mock and never
 * `FakeBillingProvider`: it drives one real subscription through charge → invoice → tax → refund →
 * reconciliation on the team sandbox, and it makes the payout/FX boundary itself executable rather than a
 * sentence in a runbook. `docs/operations/stripe-live-rollout.md` is the evidence table this suite feeds, and it
 * names which of the nine remain live-only and why.
 *
 * Skipped by default. Needs `STRIPE_SANDBOX_SECRET_KEY` (a real `sk_test_` key, deliberately separate from the
 * app's own `STRIPE_SECRET_KEY` so this suite's created/deleted objects never share an idempotency namespace
 * with the running app) plus an explicit opt-in, so `pnpm test` and CI never silently make network calls:
 *
 *   RUN_STRIPE_INTEGRATION_TESTS=1 pnpm vitest run tests/unit/shared/lib/billing/canary-certification.test.ts
 *
 * The two observations this suite deliberately does NOT cover, because they are proven better elsewhere against a
 * real database rather than against Stripe:
 * - **the grant** — `webhook-handlers.test.ts` projects entitlements and grants credits from real event shapes
 *   inside a disposable Postgres, including duplicate and out-of-order delivery;
 * - **rollback** — `stripe-provider.test.ts` pins that `getBillingProvider()` returns the fake whenever the flag
 *   is off, which is the whole kill switch.
 */
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUBSCRIPTION_CATALOG } from '~/shared/lib/billing/catalog'
import { RealBillingProvider } from '~/shared/lib/billing/real-provider'
import type { BillingRefund } from '~/shared/lib/billing/provider'

const rawSecretKey = process.env.STRIPE_SANDBOX_SECRET_KEY
const rawApiVersion = process.env.STRIPE_API_VERSION
const hasRealTestKey = Boolean(rawSecretKey?.startsWith('sk_test_') && rawApiVersion)
const shouldRun = hasRealTestKey && process.env.RUN_STRIPE_INTEGRATION_TESTS === '1'

const proMonthly = SUBSCRIPTION_CATALOG.pro_monthly

/**
 * The Account this key belongs to.
 *
 * `accounts.retrieve` is typed as requiring an account id, but the runtime resolves an absent one to the
 * caller's own account — which is the only account this suite has any business asking about, and asking by id
 * would defeat the point of test 6 (proving the key points where we think it does).
 */
function retrieveOwnAccount(client: Stripe): Promise<Stripe.Account> {
  return (client.accounts.retrieve as unknown as () => Promise<Stripe.Account>)()
}

/** One real subscription, created once and observed by every test below — a canary is a single journey. */
interface Canary {
  customerId: string
  subscriptionId: string
  invoice: Stripe.Invoice
  paymentIntent: Stripe.PaymentIntent
}

describe.skipIf(!shouldRun)('Denmark canary — the observations test mode can certify', () => {
  let stripe: Stripe
  let provider: RealBillingProvider
  let account: Stripe.Account
  let canary: Canary
  let refund: BillingRefund

  beforeAll(async () => {
    if (!proMonthly.stripePriceId.test) {
      throw new Error('catalog.ts has no test Price ID for pro_monthly — run pnpm stripe:provision --write first')
    }
    stripe = new Stripe(rawSecretKey!, { apiVersion: rawApiVersion as Stripe.LatestApiVersion })
    provider = new RealBillingProvider(stripe)
    account = await retrieveOwnAccount(stripe)

    // A Danish customer, because the canary is a Danish customer. The address is what Stripe Tax resolves the
    // jurisdiction from, so a customer with no address would silently make the tax observation meaningless.
    const customer = await stripe.customers.create({
      email: `canary-${Date.now()}@example.com`,
      name: 'Canary Test Customer',
      address: { country: 'DK', city: 'København', postal_code: '1050', line1: 'Kongens Nytorv 1' },
    })
    const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: paymentMethod.id } })

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: proMonthly.stripePriceId.test }],
      automatic_tax: { enabled: true },
      expand: ['latest_invoice.payments'],
    })

    const invoice = await stripe.invoices.retrieve(
      typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice!.id!,
      { expand: ['payments', 'total_taxes'] },
    )
    // The invoice's payment is reached through its payment records, not a top-level `payment_intent` field —
    // that field was removed from the Invoice object in this API version (`2026-06-24.dahlia`).
    const paymentRecord = invoice.payments?.data[0]
    const paymentIntentId = paymentRecord?.payment?.payment_intent
    if (typeof paymentIntentId !== 'string') {
      throw new Error(`canary invoice ${invoice.id} carries no payment intent — cannot certify the charge`)
    }
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] })

    canary = { customerId: customer.id, subscriptionId: subscription.id, invoice, paymentIntent }
  }, 60_000)

  afterAll(async () => {
    if (!canary) return
    // Cancel before deleting: a deleted customer's subscription is canceled by Stripe anyway, but doing it
    // explicitly keeps the sandbox's subscription list honest for anyone reading the dashboard afterwards.
    await stripe.subscriptions.cancel(canary.subscriptionId).catch(() => undefined)
    await stripe.customers.del(canary.customerId).catch(() => undefined)
  }, 30_000)

  it('1 — charges a real card and pays the first invoice', () => {
    expect(canary.paymentIntent.status).toBe('succeeded')
    expect(canary.invoice.status).toBe('paid')
    expect(canary.invoice.amount_remaining).toBe(0)
    // Charged at least the catalog price — `toBe` would break the moment a tax registration exists, and the
    // point being certified is that money moved for this subscription, not the exact total.
    expect(canary.invoice.amount_paid).toBeGreaterThanOrEqual(proMonthly.amountCents)

    const charge = canary.paymentIntent.latest_charge
    expect(typeof charge === 'object' && charge?.paid).toBe(true)
  })

  it('2 — finalizes an invoice a customer could actually be shown', () => {
    /**
     * A charge with no presentable invoice behind it is an accounting problem, not a success: Danish bookkeeping
     * rules require the customer to receive a numbered document, and `stripe-accounting.md`'s handoff reads
     * these fields.
     */
    expect(canary.invoice.number).toBeTruthy()
    expect(canary.invoice.currency).toBe(proMonthly.currency)
    expect(canary.invoice.hosted_invoice_url).toMatch(/^https:\/\//)
    expect(canary.invoice.invoice_pdf).toMatch(/^https:\/\//)
    expect(canary.invoice.customer_address?.country).toBe('DK')

    const line = canary.invoice.lines.data[0]
    expect(line?.pricing?.price_details?.price).toBe(proMonthly.stripePriceId.test)
  })

  it('3 — resolves a tax result, and the amount matches what the account is actually registered for', async () => {
    /**
     * Stated as an invariant rather than a snapshot, because the two halves of it live in different places.
     *
     * Stripe Tax only charges tax in jurisdictions the account holds a registration for, and registrations are
     * per-mode. This sandbox has Stripe Tax `active` with a Danish head office and **zero test-mode
     * registrations**, so a correct system charges 0 tax here — while live mode, which does hold the DK
     * registration recorded in `stripe-launch-register.md`, charges 25%. Asserting "tax is 0" would pin the
     * sandbox's configuration; asserting "tax follows the registrations" certifies the mechanism and stays true
     * the moment someone adds a test-mode registration to mirror live (see `stripe-live-rollout.md` for that
     * one command, and why it is an operator decision rather than something a test suite should do).
     */
    expect(canary.invoice.automatic_tax.status).toBe('complete')

    const registrations = await stripe.tax.registrations.list({ status: 'active', limit: 100 })
    const registeredInDenmark = registrations.data.some((registration) => registration.country === 'DK')

    const taxTotal = (canary.invoice.total_taxes ?? []).reduce((sum, entry) => sum + entry.amount, 0)
    expect(taxTotal > 0, registeredInDenmark
      ? 'an active DK registration must produce a non-zero tax amount'
      : 'with no active tax registration, Stripe Tax must charge nothing').toBe(registeredInDenmark)
  })

  it('4 — refunds the charge through the adapter the app actually uses', async () => {
    // Through `RealBillingProvider`, not `stripe.refunds.create` directly: the observation being certified is
    // that OUR refund path works against real Stripe, which is what `stripe-refunds.md` sends operators to.
    refund = await provider.createRefund({
      paymentIntentId: canary.paymentIntent.id,
      amount: canary.invoice.amount_paid,
      idempotencyKey: `canary-refund-${canary.invoice.id}`,
    })

    expect(refund.status).toBe('succeeded')
    expect(refund.amount).toBe(canary.invoice.amount_paid)
    expect(refund.paymentIntentId).toBe(canary.paymentIntent.id)

    const refreshed = await stripe.paymentIntents.retrieve(canary.paymentIntent.id, { expand: ['latest_charge'] })
    const charge = refreshed.latest_charge
    expect(typeof charge === 'object' && charge?.refunded).toBe(true)
  }, 30_000)

  it('5 — hands every object it just created to the reconciliation reader', async () => {
    /**
     * `reconciliation.test.ts` proves the *diffing* logic against injected mismatches; what it cannot prove is
     * that the reader actually sees real Stripe objects, since it runs on the fake. This certifies the seam:
     * four object types, each fetched through real auto-pagination, each containing the canary.
     */
    const since = new Date(canary.paymentIntent.created * 1000 - 60_000).toISOString()

    const [customers, subscriptions, paymentIntents, refunds] = await Promise.all([
      provider.listForReconciliation('customers', { since }),
      provider.listForReconciliation('subscriptions', { since }),
      provider.listForReconciliation('payment_intents', { since }),
      provider.listForReconciliation('refunds', { since }),
    ])

    const ids = (rows: unknown[]) => rows.map((row) => (row as { id: string }).id)
    expect(ids(customers)).toContain(canary.customerId)
    expect(ids(subscriptions)).toContain(canary.subscriptionId)
    expect(ids(paymentIntents)).toContain(canary.paymentIntent.id)
    expect(ids(refunds)).toContain(refund.id)
  }, 60_000)

  it('6 — keeps Denmark the only country the seller sells into', async () => {
    /**
     * The Stripe-side half of "keep EU countries disabled". `seller-profile.test.ts` pins the recorded
     * allowlist; this pins the fact the allowlist is about — the account this key belongs to is the Danish
     * individual account `stripe-launch-register.md` describes, not some other account a rotated key might
     * point at. An allowlist recorded in our database against the wrong Stripe account is decoration.
     */
    expect(account.country).toBe('DK')
    expect(account.business_type).toBe('individual')
    expect(account.charges_enabled).toBe(true)
  })

  it('7 — proves test mode cannot certify payout or FX facts, which is why they stay in phase-5', async () => {
    /**
     * The executable form of the boundary, so the split this suite is built on cannot quietly rot into
     * "everything is certified".
     *
     * Two independent reasons, both checked:
     *
     * 1. **No payout objects exist at all.** Test-mode balances accumulate from test charges but Stripe never
     *    runs a payout against them — there is no bank account and no settlement, so there is nothing whose
     *    arrival date, fee, or reversal could be observed.
     * 2. **Every sale crosses a currency.** The catalog prices in USD (`catalog.ts`) while this Danish account
     *    settles in DKK, so each payout involves a conversion. Its spread and timing are facts about Stripe's
     *    real FX handling, and no test-mode object carries them.
     */
    const payouts = await stripe.payouts.list({ limit: 10 })
    expect(payouts.data, 'test mode produces no payouts to observe').toHaveLength(0)

    const balance = await stripe.balance.retrieve()
    expect(balance.livemode).toBe(false)

    expect(account.default_currency).toBe('dkk')
    expect(proMonthly.currency).not.toBe(account.default_currency)
  }, 30_000)
})
