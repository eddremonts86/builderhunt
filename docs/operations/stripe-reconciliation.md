# Stripe Billing Daily Financial Reconciliation

## What this checks

`src/shared/lib/billing/reconciliation.ts`'s `runReconciliation` pages through the provider's own
listing of **customers**, **subscriptions**, **payment intents**, and **refunds**
(`BillingProvider.listForReconciliation`) and compares each against this app's internal record for
the same object, across every organization — the same O(organizations) cross-org sweep pattern
`operations-metrics.ts` already establishes (worker-role, one organization at a time), not a new
access pattern. It never fabricates a "clean" result: every mismatch it finds is recorded, and the
only thing it ever auto-repairs is a stale subscription mirror (see below).

## Scope decisions

- **Disputes are not paged through here.** Unlike the other four object types, this app never
  *creates* a dispute — Stripe always initiates it, and the only way we ever learn about one is a
  signed `charge.dispute.*` webhook event (see `stripe-disputes.md`). There is no "did we create what
  Stripe has" drift class for an object type we never write to; dispute integrity is a
  webhook-signature-and-idempotency concern, already covered.
- **Payment intents reconcile by existence only.** This app never stores a payment intent's own
  status/amount locally — the only internal trace of one is `billing_credit_grants.stripe_payment_intent_id`
  (set for pack purchases and auto-recharge grants). A payment intent Stripe reports **succeeded**
  with no matching credit-grant row is the single most financially serious mismatch this function can
  find — money collected, credits possibly never issued — and is exactly what `missing_internal` on
  this object type is built to catch.
- **Only currently-active subscriptions are compared** (the same query `subscription-changes.ts`
  uses for plan changes). A canceled subscription carries no further financial risk to reconcile.
- **"Duplicate" means the provider's own listing repeats an id** (a pagination/listing artifact) —
  an internal duplicate is structurally impossible for customers/subscriptions (both have a
  database-level unique index on their Stripe id), so there is no separate "duplicate internal"
  class.

## Mismatch types

| Type | Meaning |
| --- | --- |
| `missing_internal` | The provider has this object; no internal row references it. |
| `extra_internal` | An internal row references an id the provider does not have. |
| `stale_internal` | Both sides have it, but key fields disagree (subscriptions: status/`cancelAtPeriodEnd`/`currentPeriodEnd`; refunds: state). |
| `duplicate_provider_listing` | The provider's own listing for an object type contained the same id more than once. |

## The one auto-repair

`syncBillingSubscriptionMirrorFromProvider` (`repositories/billing.ts`) is the **only** repair this
function ever applies automatically: re-syncing the three fields that mirror provider-authoritative
subscription state — the same fields a real webhook event (`handleSubscriptionUpsert`) would set.
It is pure, idempotent, side-effect-free field replacement with no financial action of its own (no
charge, no grant, no cancellation trigger), which is why it is the one case safe enough to apply
without a human in the loop. Every other mismatch (missing/extra on any type, any duplicate) is
**report-only forever** — creating or deleting a financial row automatically could paper over a real
bug or silently duplicate/lose money, which is never "safe."

## Running it

```sh
curl -X POST '/api/admin/billing/reconcile' \
  -H 'Cookie: <admin session>'
```

Same dual-auth as `api/admin/billing/run-worker.ts` — either a platform-admin session, or a
`CRON_SECRET`-bearing request (`Authorization: Bearer <CRON_SECRET>` or `X-Cron-Secret: <CRON_SECRET>`)
for an external scheduler with no session at all. Point a daily scheduled job at this endpoint; there
is no in-process cron in this bootstrap deployment (same as the billing worker and legal-deletion
sweeps).

### Resumable cursor

A single call has a wall-clock budget (`maxDurationMs`, default 60s). If it's exceeded, the run stops
after finishing whichever object type it was on and returns a `resumeCursor` — pass that straight
back as `{ "resumeFrom": { "objectType": "..." } }` in the next call's body to continue rather than
restart. **No run row is persisted for a partial pass** — only the call that completes every object
type writes a durable `billing_reconciliation_runs` row. A scheduler that always calls this endpoint
with an empty body is safe: a stuck/interrupted resume simply restarts from `customers` on the next
tick rather than accumulating stale partial state.

## Reading results

Every completed run writes one `billing_reconciliation_runs` row: `window_start`/`window_end`,
`counts_checked` (per object type), `mismatches` and `repairs` (both `{type, reference, detail|action}`
JSON arrays — `reference` combines the object type and provider id since the table has no separate
column for each), and `result` (`clean` | `mismatches_found` | `repairs_applied`). The platform billing
operations dashboard (`/admin/billing`) surfaces the most recent run's `result` and `window_end`
directly — see `docs/operations/stripe-live-readiness.md`'s `reconciliationEvidenceRecent` gate,
which requires a `result: 'clean'` row within the last 48 hours before live billing can be enabled.

## Data model

`billing_reconciliation_runs` — platform-private, no organization scoping (a run is inherently
cross-organization; there is no single tenant to scope RLS by). `builderhunt_worker` gets INSERT
only (written once per completed run by `runReconciliation` itself); `builderhunt_platform` gets
SELECT only (read by the ops dashboard and by operators reviewing history); `builderhunt_app` has no
access at all. This table was created in the original `0027`/`0028` migrations, well before this
task — it existed as a placeholder for exactly this feature.
