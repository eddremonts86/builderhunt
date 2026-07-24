# Stripe Billing Monthly Accounting Export

## What this produces

`src/shared/lib/billing/accounting-export.ts`'s `getAccountingExport` composes one monthly report
across every organization — the same O(organizations) cross-org sweep pattern
`operations-metrics.ts`/`reconciliation.ts` already establish (worker-role, one organization at a
time), not a new access pattern. Every line item is either computed from real, stored data, or
reported as explicitly unavailable — it never fabricates a number for something this app doesn't
actually track.

## What has real backing data

- **Gross revenue** — an ESTIMATE derived from the immutable catalog list price (`catalog.ts`), not
  a ledger of actual Stripe charges. This app never persists an invoice's own amount (see "What does
  NOT have real data" below), so:
  - **Subscription revenue** counts every `billing_subscriptions` row whose `current_period_start`
    falls inside the window, resolved to that row's own `catalog_key` → catalog `amountCents`. A new
    billing period starting is the closest available proxy for "an invoice was likely issued" without
    an actual invoice record.
  - **Pack revenue** counts every pack-sourced `billing_credit_grants` row (`source = 'pack'`) whose
    `created_at` falls inside the window, resolved via `source_reference` (the pack catalog key) →
    catalog `amountCents`. This one is exact, not an estimate — a pack grant's creation IS the
    purchase event.
- **Refunds** — summed straight from `billing_refunds`, counting only `state: 'succeeded'` rows
  (money actually returned) with `created_at` inside the window.
- **Disputes** — summed straight from `billing_disputes`, `created_at` inside the window. Pack
  purchase disputes only — see `disputes.ts`'s own module comment on the subscription-invoice
  dispute gap (Stripe subscription disputes are never recorded in this app).
- **Unexpired-credit liability** — `sum(remaining_units)` over `billing_credit_grants` rows that are
  `state: 'active'` AND not yet past `expires_at`. This is a point-in-time, cross-organization total
  (not window-filtered) — the outstanding credit obligation as of "now", in credit units (not
  dollars, since credits have no fixed per-unit dollar redemption rate).

## What does NOT have real data (reported as `{ available: false, reason }`)

None of these are estimated or fabricated — each is a scope decision, same principle as
`operations-metrics.ts`'s `costMargin: { available: false }`:

| Field | Why it's unavailable |
| --- | --- |
| `discounts` | No coupon/discount amount is ever persisted — `allowPromotionCodes` is a checkout-time flag only; the resulting discount is never stored. |
| `tax` | Stripe Tax computes and owns the collected tax amount; this app never persists an invoice's tax line. |
| `stripeFees` | `BillingProvider` (`provider.ts`) exposes no balance-transaction or fee data at any layer, and no real Stripe adapter exists yet to source it from (`stripe-provider.ts` deliberately throws if `STRIPE_BILLING_ENABLED` is set). |
| `payout` | Same as above — no payout currency/FX/net data exists; Stripe alone owns payout scheduling and currency conversion. |
| `outstandingInvoices` | No invoice entity is ever persisted. `invoice.paid`/`invoice.payment_failed` are handled as pure webhook trigger events (grant credits / start dunning) — the invoice's own amount/id/status is never stored. |
| `providerCostByTierFeature` | `billing_provider_usage` exists in the schema (`estimated_cost_cents`/`actual_cost_cents` columns, RLS/grants already in place) specifically for this, but nothing in the app ever inserts a row into it yet. Wiring real cost tracking into the reservation-settlement path is a separate, not-yet-built task. |

If a real Stripe adapter and/or `billing_provider_usage` writes are added later, these fields are the
natural extension points — populate them from real data at that point rather than estimating now.

## Running it

```sh
curl 'https://app/api/admin/billing/accounting-export?month=2026-06' \
  -H 'Cookie: <admin session>'
```

Platform-admin only (`requirePlatformAdminPrincipal`) — no cron/external-scheduler dual-auth like
`reconcile.ts`, since this is a pull-based report with no side effects to replay or dedupe.

- `?month=YYYY-MM` selects a specific UTC calendar month. Omit it to get the previous full calendar
  month relative to the server's current time (the natural default for a report run just after
  month-end).
- `?format=csv` returns a flat `metric,value,unit,note` table (one row per line item, including the
  unavailable ones with their reason in the `note` column) for spreadsheet import. Omit it (or pass
  anything else) for the nested JSON shape.

## Data model

Reads only — writes nothing. Every table it reads (`billing_subscriptions`, `billing_credit_grants`,
`billing_refunds`, `billing_disputes`) already exists from earlier tasks; no schema change was needed
for this task.
