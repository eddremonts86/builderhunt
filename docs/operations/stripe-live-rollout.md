# Stripe Live Rollout — the Denmark canary, split by what is provable today

The staged path from "billing works against Stripe test mode" to "real Danish customers are charged
real money", and — the reason this document exists — an explicit split of the canary's nine
observations into the seven that are **certified now** against real test-mode Stripe and the two that
are **facts about real money** and therefore belong to phase-5.

Companion to `stripe-live-readiness.md` (the pre-flight gate table),
`stripe-launch-register.md` (the release checklist and its owners),
`stripe-sandbox-certification.md` (API-level certification in CI),
`staging-test-plan.md` in `plans/phase-1/30-stripe-billing-platform/` (test-mode coverage), and
`stripe-incident-response.md` (the kill switch, i.e. rollback).

## Why this document is a split and not a checklist

`plans/phase-1/30-stripe-billing-platform/tasks.md` §15 asks for nine observations from the canary: a
successful **charge**, an **invoice**, a **tax result**, a credit/entitlement **grant**, a **refund**,
**payout/FX facts**, **reconciliation**, **rollback**, and **EU countries staying disabled**.

Read as one atomic task, all nine were blocked on the same two things — an `sk_live_` key and a real
volunteer customer — so the task sat closed to work for weeks. But only two of the nine are actually
statements about real money. The other seven are statements about our code and about Stripe's own
behaviour, and Stripe's test mode runs the same logic against the same API. Those seven were provable
the whole time, and are now proven.

The distinction that decides which column an observation lands in:

> Would this observation still be about our system if the money were fake?

A charge, an invoice, a VAT calculation, a credit grant, a refund, a reconciliation diff, a kill
switch, and a country allowlist — yes. A payout arriving in a Danish bank account, and the FX spread
applied on the way — no. Those are the payment network's behaviour, and no test-mode object carries
them.

## Certified now — test mode, real Stripe API

`tests/unit/shared/lib/billing/canary-certification.test.ts` drives one real subscription through the
whole journey on the team sandbox (`acct_1TwK4YFbQx9fJlcG`, Denmark, individual) and cleans up after
itself. Never a mock, never `FakeBillingProvider`:

```bash
RUN_STRIPE_INTEGRATION_TESTS=1 pnpm vitest run tests/unit/shared/lib/billing/canary-certification.test.ts
```

It also runs in CI, as step 2 of the `stripe-sandbox-certification` job (skipped rather than failed
when no sandbox key is configured — see `stripe-sandbox-certification.md`).

| # | Observation | How it is certified | Evidence (run 2026-08-04, 7/7 in 9.1s) |
| --- | --- | --- | --- |
| 1 | Successful charge | Real `pm_card_visa` charged for a real `pro_monthly` subscription | PaymentIntent `succeeded`, charge `paid`, `amount_paid` 1900 |
| 2 | Invoice | The finalized invoice a customer would be shown | number `GPQDKDVZ-0055`, `status: paid`, currency `usd`, hosted URL + PDF present, `customer_address.country: DK` |
| 3 | Tax result | Stripe Tax resolves the DK jurisdiction and returns a complete calculation | `automatic_tax.status: complete`, `taxability_reason: not_collecting` — see the caveat below |
| 4 | Grant | Not here — proven better against a real database: `webhook-handlers.test.ts` projects the entitlement and grants credits from real event shapes, including duplicate and out-of-order delivery | 50 cases, disposable Postgres |
| 5 | Refund | Through `RealBillingProvider.createRefund`, the same path `stripe-refunds.md` sends operators down | refund `succeeded`, full 1900 reversed, charge `refunded: true` |
| 6 | Payout / FX | **Not certifiable — see the next section.** The suite asserts the boundary instead | 0 payout objects exist; `balance.livemode: false` |
| 7 | Reconciliation | All four object types read back through real auto-pagination and each contains the canary | customers / subscriptions / payment_intents / refunds all hit |
| 8 | Rollback | Not here — `stripe-provider.test.ts` pins that `getBillingProvider()` returns the fake whenever `STRIPE_BILLING_ENABLED` is off, which is the entire kill switch | 13 cases |
| 9 | EU countries disabled | Enforced, not just recorded: `checkout.ts:116` and `packs.ts:170` refuse a country outside the allowlist before any Stripe session is created (`country_not_allowed`), covered by `checkout.test.ts` and `packs.test.ts`. This suite pins the fact the allowlist is *about* — that the key belongs to the Danish individual account, not some other account a rotated key might point at | `country: DK`, `business_type: individual`, `charges_enabled: true` |

Seven of the nine now have evidence. Points 4 and 8 are marked "not here" rather than "not done":
both are certified, just by suites that own the relevant surface (a database, and the provider seam)
better than a Stripe integration test could.

### The tax caveat, stated because it is a real gap

Test mode returned **zero tax**, and that is the correct answer rather than a bug: Stripe Tax only
charges tax in jurisdictions the account holds a registration for, registrations are per-mode, and
this sandbox has `tax.settings.status: active` with a Danish head office but **zero test-mode
registrations**. Stripe says so itself in the invoice — `taxability_reason: not_collecting`.

Live mode does hold the DK registration recorded in `stripe-launch-register.md`, so live invoices will
carry 25% VAT while test invoices carry none. The certification test therefore asserts an *invariant*
rather than a number — tax is non-zero exactly when an active DK registration exists — so it stays
true in either configuration and starts asserting 25% the moment the sandbox mirrors live.

**To make the sandbox mirror live** (an operator decision, not something a test suite should do to a
shared account, since it changes the tax on every test invoice the whole team and CI create):

```bash
stripe tax registrations create --country=DK --active-from=now --country-options.dk.type=standard
```

Recommended before the staging environment in `staging-test-plan.md` §2.2 is used to validate
invoice/receipt copy, because a receipt with no VAT line is not the receipt a Danish customer
receives.

## Not certifiable in test mode — the two that stay in phase-5

Both are the same observation seen from two sides, and both have a concrete, checked reason rather
than an assumption:

1. **No payout objects exist at all.** Test-mode balances do accumulate from test charges — this
   sandbox holds 1156.74 DKK available and 7694.43 DKK pending — but Stripe never runs a payout
   against them. There is no bank account and no settlement, so there is nothing whose arrival date,
   fee, or reversal could be observed. `stripe.payouts.list()` returns an empty list.
2. **Every sale crosses a currency.** The catalog prices in **USD** (`catalog.ts`, all six
   subscription entries and all three packs) while this Danish account settles in **DKK**
   (`default_currency: dkk`). Every payout therefore involves a conversion, and its spread and timing
   are facts about Stripe's real FX handling that no test-mode object carries.

Point 2 is worth a decision rather than just a note: **pricing in USD while settling in DKK means the
seller absorbs an FX spread on every single sale**, and neither the pricing page nor
`stripe-accounting.md` currently accounts for it. Either price in DKK/EUR for Danish and EU
customers, or accept the spread deliberately with a figure attached. Not a code change, and not this
document's call — but it should not be discovered from the first real payout statement.

The canary's remaining live-only content is therefore small and specific: one real customer, one real
charge, one payout observed end to end with its FX line, and one refund reversed through the same
path. Everything the code has to do for that to work is already certified.

## The staged rollout

Order matters, and each step is reversible with `STRIPE_BILLING_ENABLED=false` + redeploy (see
`stripe-incident-response.md` — note that rollback stops new Stripe activity and nothing else; the
support path during an incident is the operator grant on `/admin/users`).

### Step 0 — pre-flight

```bash
pnpm billing:check-readiness --confirm-terms-privacy --confirm-runbooks --confirm-portal-configuration
```

Must report ready. Its known gaps are documented in `stripe-live-readiness.md` and are not waived by
this document. Production still needs its Stripe env vars pushed to Coolify — the register records
that they were absent as of 2026-07-24 and this is a hard blocker, not a warning.

### Step 1 — live catalog, read-only

Confirm every active catalog entry's `live` Price ID resolves against the live key, with
`STRIPE_BILLING_ENABLED` still `false`. Nothing can be charged while the flag is off, so this is a
pure read. `pnpm stripe:provision` without `--write` is the check.

### Step 2 — webhook ingestion only

Point the live webhook endpoint at production and confirm events land in `billing_webhook_events`.
With the flag off the worker does not drain the inbox, which is exactly what makes this step safe: the
events accumulate and can be inspected before anything acts on them.

### Step 3 — internal account

Flip the flag, subscribe an internal organization with a real card, and observe all nine points
including the two this document defers. This is the first time real money moves and it moves between
two accounts the team owns.

### Step 4 — one voluntary Danish customer

The canary proper. Requires informed consent (they are knowingly first), the full nine-point
observation, and a refund path rehearsed before the charge rather than after.

### Step 5 — percentage rollout

Only after step 4's evidence is attached to `stripe-launch-register.md`. Keep every country except
Denmark disabled until the EU/OSS work in `stripe-tax.md` is done — this is not a throughput
constraint but a tax-registration one.

## Change log

- 2026-08-04 — document created. Seven of the canary's nine observations certified against real
  test-mode Stripe (`canary-certification.test.ts`, 7/7). Two findings recorded rather than smoothed
  over: the sandbox holds no test-mode tax registration, so test invoices legitimately carry no VAT
  while live invoices will carry 25%; and the catalog prices in USD while the seller settles in DKK,
  putting an unaccounted FX spread on every sale.
