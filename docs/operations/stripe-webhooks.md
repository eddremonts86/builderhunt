# Stripe Webhooks: Receipt, Processing, Retry, and Replay

## The three-stage pipeline

1. **Receipt** (`POST /api/webhooks/stripe`, `src/shared/lib/billing/webhook-inbox.ts`) — verifies
   `Stripe-Signature` against the current (and, during rotation, previous) endpoint secret, rejects
   an API-version/livemode mismatch, and durably inserts one row per unique
   `(livemode, stripe_event_id)` into `billing_webhook_events` — before ever returning `2xx`. No
   user session is required or checked; the signature IS the authentication.
2. **Processing** (`src/shared/lib/billing/webhook-handlers.ts`) — applies one already-verified event
   idempotently and monotonically (`subscription-state.ts`'s transition gate). Never called directly
   from the receipt route in the current build — see "Why processing is worker-driven" below.
3. **Retry and replay** (`src/shared/lib/billing/worker.ts`, this task) — claims pending/retryable
   rows with a lease (`FOR UPDATE SKIP LOCKED`), re-fetches the FULL event from Stripe, calls the
   processing stage, and applies bounded exponential backoff with dead-lettering. A separate,
   explicit single-event replay path exists for platform-admin-audited manual intervention.

## Why the worker re-fetches from Stripe instead of using the stored payload

`billing_webhook_events.payload_encrypted` deliberately stores only a **minimized** payload (event
id/type/timestamps and the affected object's id/type — spec.md: "minimized, encrypted where
retained"). That is enough for our own audit trail, but not enough to re-run the handlers, which
need the full object body (a subscription's items/price, an invoice's period, etc.).

The correct fix — and what Stripe's own integration guidance describes — is to re-fetch the full
event from Stripe itself via `stripe.events.retrieve(eventId)` (Stripe retains full event bodies for
30 days), never to try to reconstruct it from our own deliberately-lossy local copy.
`src/shared/lib/billing/worker.ts`'s `EventRetriever` is the seam for this:
`createStripeEventRetriever()` calls the real Stripe SDK in production; tests inject a fake one
returning canned fixtures — the same dependency-injection pattern this entire plan uses for
`BillingProvider`.

**Operational implication**: once an event passes 30 days old, Stripe can no longer return it, and
`retrieveEvent` returns `null` — the worker dead-letters that row (`status: 'failed'`) rather than
retrying forever. In practice this should never happen: the worker runs far more often than every 30
days, and a healthy pipeline processes almost everything within its first few attempts.

## Running the worker

```sh
curl -X POST https://<host>/api/admin/billing/run-worker \
  -H "Cookie: <a platform-admin session cookie>"
```

There is no OS-level cron in this bootstrap deployment (matching every other `run-worker.ts` route
in this codebase) — point an external scheduler (systemd timer, Coolify scheduled task, or a plain
`curl` in a crontab) at this endpoint, authenticated as a platform admin. Each run:

- Claims up to 25 pending/retryable webhook events (a 5-minute lease; a crashed run's claimed rows
  become reclaimable once the lease expires — this is what makes a crashed worker process safe).
- Processes each: `'processed'` (applied or genuinely unrecognized), `'deferred'` (a recognized
  family with no dependent infrastructure yet — PaymentIntent/refund/dispute families today —
  stays `pending`, retried on the same backoff schedule, never treated as an error),
  `'retry_scheduled'` (the handler threw; backed off exponentially, 30s doubling to a 1-hour cap),
  or `'dead_lettered'` (exhausted 8 attempts, or Stripe no longer has the event — `status: 'failed'`,
  never retried automatically again).
- Sweeps every organization's credit grants for ones past their natural expiry and expires them
  (`credits.ts`'s `expireCreditGrant`).

**Dead-letter alerting**: this task does not yet wire up a notification channel — a `status: 'failed'`
row is currently only visible by querying `billing_webhook_events` directly
(`select * from billing_webhook_events where status = 'failed' order by received_at desc`). Wiring
this into an actual alert (email/Slack/PagerDuty) is a follow-up, not blocking initial launch, since
`STRIPE_BILLING_ENABLED` stays `false` until every gate in `docs/operations/stripe-live-readiness.md`
— including `operatorRunbooksConfirmed` — has real evidence, and that gate is exactly where "we now
have a real alerting channel for dead letters" belongs.

## Recovering a stuck or dropped event

Two independent recovery paths exist — use the one that matches the situation:

### 1. Stripe resend (the event never reached us, or we can't find our own copy of it)

In the Stripe Dashboard: Developers → Webhooks → (your endpoint) → find the event → **Resend**.
Stripe re-delivers the exact same event id with a fresh signature. Our receipt endpoint's own
`(livemode, stripe_event_id)` uniqueness means this is always safe to do speculatively — if we
already have it, the resend is a harmless duplicate-insert no-op; if we don't, it arrives as if new.

### 2. Internal replay (we have the row, but it's stuck `pending`/`processing`/`failed`)

```sh
curl -X POST https://<host>/api/admin/billing/events/<eventRowId>/replay \
  -H "Cookie: <a platform-admin session cookie>"
```

This bypasses the claim/lease mechanism entirely and re-processes the row immediately, regardless of
its current status — including an already-`processed` row (harmless: `processStripeWebhookEvent`'s
own idempotency guarantees mean replaying an applied event is a no-op) or a dead-lettered one (the
usual path after diagnosing and fixing whatever made it a poison event). Every replay is audited via
`auditPlatformAdminAction` (`action: 'admin.billing.events.replay'`), recording who replayed what and
when.

Use `<eventRowId>` — the `billing_webhook_events.id` primary key, not the Stripe event id — found by
querying the table directly.

## What this worker does NOT do yet

- **Dunning/grace enforcement** (blocking access after 7 days of failed payment) — §7 task 6, not yet
  built. `invoice.payment_failed` only records the grace-period marker
  (`billing_subscriptions.grace_period_ends_at`); nothing currently reads and acts on it.
- **Auto-recharge processing** — §8 task 5, not yet built.
- **Notices/emails** for any billing event — no email integration exists in this pipeline yet.
- **PaymentIntent, refund, and dispute processing** — packs (§8 task 1), refund review (§8 task 4),
  and dispute handling (§8 tasks 2-3) don't exist yet; those event families are recorded as
  `'deferred'` and safely retried indefinitely until that infrastructure lands.

Each of the above is a small, additive extension of `runBillingWorker`'s sweep once its dependency
lands — not a redesign of the claim/lease/retry/replay machinery this task built.
