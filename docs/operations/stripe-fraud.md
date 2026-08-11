# Stripe Billing Fraud and High-Volume Exception Controls

## What this protects

Packs and auto-recharge (`src/shared/lib/billing/packs.ts`, `src/shared/lib/billing/auto-recharge.ts`)
are the two "repeat off-session charge" surfaces spec.md calls out as the "spend-then-chargeback abuse"
vector. `src/shared/lib/billing/risk.ts` adds a second, independent gate on top of the existing
rolling 24h charge/dollar limit (`packs.ts`'s `assertWithinRollingPackChargeLimit`, shared by both
surfaces): a payment-**failure velocity** check that blocks a new purchase attempt once an
organization has racked up `PAYMENT_FAILURE_VELOCITY_THRESHOLD` (currently 3) declined attempts in
the trailing `PAYMENT_FAILURE_VELOCITY_WINDOW_MS` (24 hours).

This is a blunt, honest instrument, not a full fraud-scoring system:

- **No separate Radar risk score is consumed.** This codebase's `BillingProvider` boundary
  (`provider.ts`) doesn't expose one — the practical signal every real Stripe integration acts on
  either way is the outcome itself. A `BillingProviderError` from Checkout/PaymentIntent creation
  **is** Stripe's (Radar- and 3DS-informed) decline decision, and that's exactly what
  `recordPaymentFailure` counts.
- **Payment-method-rotation velocity is not tracked yet.** This codebase never observes or stores
  payment-method changes — Stripe's Customer Portal (`portal.ts`) owns that entirely today. The
  `billing_risk_events.event_type` CHECK constraint already allows a future `'card_rotation'` event
  so this is a pure additive follow-up, not a redesign, once that visibility exists.
- **Dispute velocity is not tracked yet** — it depends on disputes existing at all
  (plans/implemented/30-stripe-billing-platform/tasks.md §8 task 5, not yet built). The schema already allows a
  `'dispute_opened'` event type for the same reason.

## What gets blocked, and what never does

`assertNotRiskBlocked` is called from exactly two places, both **new-purchase creation** paths:

- `packs.ts`'s `createPackCheckout`, right before creating a new Checkout Session.
- `auto-recharge.ts`'s `maybeTriggerAutoRecharge`, right before creating a new off-session
  PaymentIntent.

It is never called from a read path, from subscription access, or from data/export access — an
organization that trips this gate keeps everything it already has; it just cannot start a **new**
pack purchase or auto-recharge attempt until reviewed. This mirrors `dunning.ts`'s own "preserves all
data/export access" invariant for payment-blocked subscriptions.

A block **never** bypasses a successful payment or any ledger rule in the other direction either:
lifting the block (via an operator exception, below) only permits *attempting* a new Checkout/
PaymentIntent again — the purchase still has to actually succeed through the normal path
(`grantCredits`, webhook confirmation) to grant anything.

## Reviewing and issuing an exception

Platform operators review and issue time-bounded exceptions through `/api/admin/billing/risk-exceptions`
(platform-admin authenticated, audited via `auditPlatformAdminAction` like every other admin billing
mutation):

```sh
# List exceptions ever issued for an organization
curl -X GET '/api/admin/billing/risk-exceptions?organizationId=org_123' \
  -H 'Cookie: <admin session>'

# Issue a 7-day exception with a reason on file
curl -X POST /api/admin/billing/risk-exceptions \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <admin session>' \
  -d '{"organizationId": "org_123", "reason": "Confirmed legitimate card update after bank fraud hold", "durationMs": 604800000}'

# Revoke an exception early
curl -X DELETE /api/admin/billing/risk-exceptions \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <admin session>' \
  -d '{"organizationId": "org_123", "exceptionId": "exc_123"}'
```

An exception is capped at `MAX_RISK_EXCEPTION_DURATION_MS` (30 days) — a longer or open-ended
exception is not "time-bounded" and must be re-issued after review instead. Only one active
(un-revoked, unexpired) exception is ever consulted at a time (`findActiveRiskException` reads the
most recently issued one); issuing a new exception while one is already active is allowed and simply
supersedes it for `assertNotRiskBlocked`'s purposes, but both remain on the audit trail.

## Data model

- `billing_risk_events` — append-only, tenant-private. One row per observed signal
  (`payment_failure` today). Never updated after insert, matching `billing_ledger_entries`' own
  convention.
- `billing_risk_exceptions` — tenant-private, platform-operator-write-only. `reason`,
  `issued_by_user_id`, `issued_at`, `expires_at`, and a nullable `revoked_at` are the complete audit
  trail for "who decided this, why, and for how long."

Both are RLS-scoped by `organization_id` like every other tenant-private billing table (see
`drizzle/0033_billing_risk_rls_grants.sql`); a platform operator's queries run through
`repositories/billing-risk.ts`'s `withPlatformOrganization`, which sets the RLS session context for
the target organization the same way `repositories/billing-worker.ts`'s `withWorkerOrganization`
already does for the worker role.
