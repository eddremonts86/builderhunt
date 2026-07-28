# Stripe Billing Financial Notifications, Metrics, and Alerts

## Notifications

`src/shared/lib/billing/notifications.ts`'s `runNotificationSweep` covers all seven message types
plans/phase-1/29-stripe-billing-platform/tasks.md §10 names — renewal, grace, action-required, expiry-30/7/1
(three windows, one message family), refund, dispute, reconciliation — using the same O(organizations)
cross-org sweep pattern `reconciliation.ts`/`operations-metrics.ts` already establish. It deliberately
does **not** modify any existing writer (`webhook-handlers.ts`, `refunds.ts`, `disputes.ts`,
`reconciliation.ts`) — this module only reads their tables and decides, per (organization,
notification type, policy window), whether a notification is due.

### Deduplication

The dedup mechanism is `billing_notification_log`'s unique index on
`(organization_id, notification_type, window_key)`: `recordNotificationIfDue` does an
`ON CONFLICT DO NOTHING RETURNING` insert, and the caller only sends the real email if a row was
actually inserted. This guarantees "one notification per policy window" even if the sweep runs more
than once inside the same window (a scheduler retry, or running twice in the same day).

Window keys, one per message type:

| Type | Window key | Notes |
| --- | --- | --- |
| `credit_expiry_30` / `credit_expiry_7` / `credit_expiry_1` | grant id | The notification TYPE itself distinguishes the bucket, so one grant can send at most one T-30, one T-7, and one T-1 notice — never more. |
| `subscription_renewal` | `subscriptionId:currentPeriodEnd date` | A new period end date is a genuinely new window — a renewing subscription gets a fresh reminder every cycle. Skipped for a subscription already `cancelAtPeriodEnd`. |
| `grace_period` / `action_required` | `subscriptionId:marker timestamp` | Tied to the specific grace/block INSTANCE — a subscription can enter grace or get blocked more than once over its life; each instance gets exactly one notice. |
| `refund_decision` | refund id | A refund is decided once (`state: 'succeeded' \| 'failed'`). |
| `dispute_opened` | dispute id | One notice per dispute. |
| `reconciliation_mismatch` | run id | Platform-wide (`organization_id = 'platform'`, no single tenant to scope to) — one alert per non-clean run. |

### Recipients

Every notification goes to `billingNotificationRecipients` — the organization owner's account email,
plus the verified billing contact's if one exists and differs (deduped). This function was moved out
of `webhook-handlers.ts` (where it was private, used only by the invoice-receipt and
payment-failed-notice sends) into this module and is now shared by both real webhook-driven sends and
this sweep.

### Scheduling

This sweep requires an external scheduler to invoke it periodically (at least once daily, to catch
each exact expiry-day/renewal-day bucket) — same "no in-process cron in this bootstrap deployment"
pattern as `reconciliation.ts`/`worker.ts`. There is no dedicated route for it yet in this task's file
list; wiring one (mirroring `api/admin/billing/reconcile.ts`'s dual cron/platform-admin auth) is the
natural next step whenever a scheduler is configured.

## Metrics

`src/shared/lib/billing/operations-metrics.ts`'s `getBillingOperationsMetrics` gained six new field
families for this task, alongside the existing webhook-backlog/grace/refund/dispute/risk-exception/
credit-invariant/reconciliation/cost-margin fields:

| Field | What it measures | Real backing data? |
| --- | --- | --- |
| `checkout` | Last 24h of `billing_checkout_attempts`, by status, across every organization | Yes — read per-organization through the worker-scoped sweep (`billing_checkout_attempts` has no `builderhunt_platform` RLS policy, only `app`/`worker`, so this can never be a bare `platformDb` query). |
| `recovery` | Organizations currently recovering (`inGrace`) vs. currently blocked (`blocked`, grace exhausted without recovery) | Yes, but a snapshot only — `billing_auto_recharge_rules`/`billing_subscriptions` have no event history, only current state. |
| `webhookAge` | Age in minutes of the oldest still-`pending` webhook event | Yes — distinct from the pre-existing `webhooks` field's mere backlog COUNT; a large age with a small count is still an SLO problem a count alone would hide. |
| `ledgerInvariant` | Recomputes each active grant's balance from its own `billing_ledger_entries` and diffs it against the denormalized `remainingUnits` column | Yes — a non-zero count is a real data-integrity bug, not a business condition. |
| `autoRecharge` | Current `billing_auto_recharge_rules` state distribution (`active`/`pausedNeedsAuth`/`pausedFailed`) across every organization | Yes, current-state snapshot only (no history). |
| `countryGate` | In-process counter of Checkout attempts rejected for `country_not_allowed` | Yes, but the only trace available — a country-gate rejection happens BEFORE any `billing_checkout_attempts` row is ever written (`checkout.ts`/`packs.ts` throw before `createBillingCheckoutAttemptIfAbsent`), so `metrics.ts`'s in-process `checkoutCountryGateRejections` counter is the only signal. Resets on server restart, same caveat as every other `metrics.ts` counter. |

`costMargin` remains `{ available: false }`, unchanged from §9 — `billing_provider_usage` exists in
the schema (`estimatedCostCents`/`actualCostCents` columns) but nothing writes to it yet; wiring real
cost tracking into the reservation-settlement path is a separate, not-yet-built task.

## Critical SLO alerts

`evaluateBillingAlerts` (`operations-metrics.ts`) is a pure function — no I/O — that takes the metrics
snapshot `getBillingOperationsMetrics` already computed and returns the critical conditions among
them as plain strings. No prior doc in this codebase defined a concrete SLO number for any of these;
this is the first place one is set, deliberately conservative (catches a real problem, not routine
noise):

| Condition | Threshold |
| --- | --- |
| Oldest pending webhook age | > 120 minutes |
| Permanently failed webhook events | > 0 |
| Credit ledger invariant violations | > 0 |
| Organizations with auto-recharge paused due to failure | > 0 |
| Most recent reconciliation run | not `clean` |

`src/routes/api/admin/metrics/index.ts` (a pre-existing, non-billing-specific platform metrics route —
distinct from `api/admin/billing/metrics.ts`, which wraps `getBillingOperationsMetrics()` 1:1 with no
alert evaluation) now includes a `billing` key: the full metrics snapshot plus `alerts: string[]` from
`evaluateBillingAlerts`.

## Data model

`billing_notification_log` — `organization_id` has no FK (mirrors
`organization_deletion_financial_records`); the `'platform'` sentinel value is used for
cross-organization notification types, which a real FK to `organizations.id` could never satisfy. Role
split: `builderhunt_worker` gets `SELECT, INSERT` (the sweep's own role, and the only writer);
`builderhunt_platform` gets `SELECT` only (operator visibility into what was already sent);
`builderhunt_app` has no access.
