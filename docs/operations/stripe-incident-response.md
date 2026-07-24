# Stripe Billing Incident Response

## Kill switch

`billing/stripe-provider.ts`'s `getBillingProvider()` — the ONE seam every checkout/portal/webhook
call path goes through — now has a real, certified Stripe-calling implementation
(`real-provider.ts`'s `RealBillingProvider`, verified against Stripe's real test-mode API; see
`docs/operations/stripe-sandbox-certification.md`). It is selected automatically whenever
`STRIPE_BILLING_ENABLED=true` AND a valid `STRIPE_SECRET_KEY`/`STRIPE_API_VERSION` are configured
(`resolveStripeClientConfig`); otherwise `getBillingProvider()` falls back to the deterministic
in-memory `FakeBillingProvider` — it never throws for a merely-disabled flag. **As of this writing,
`STRIPE_BILLING_ENABLED` is still `false` in every deployed environment (including production —
verified via the Coolify API), so everything running today still goes through the fake, in-memory
provider.** The flag itself is the entire go/no-go switch for real money; see
`stripe-live-readiness.md`'s `billingFlagEnabledInLiveMode` gate before ever setting it to `true` in
production.

The kill switch is exactly `STRIPE_BILLING_ENABLED=false` + redeploy — this is deliberately the SAME
flag `platform-billing.ts`'s `LegacyPlanMutationDisabledError` reacts to in the opposite direction, so
flipping it back to `false` in an emergency simultaneously stops new Stripe activity AND re-opens the
legacy manual plan-request path, so existing customers aren't left with no way to get support.

**What flipping it off will NOT do**: it will not cancel in-flight Stripe subscriptions, will not stop
Stripe's own retry/dunning timers, and will not un-verify already-received webhook events sitting in
`billing_webhook_events`. Those will keep accumulating (received, but never processed while the flag
is off) until the flag comes back on and the worker (`api/admin/billing/run-worker.ts`) resumes
draining the inbox.

**Owner**: Edd Remonts (confirmed 2026-07-24 — `stripe-launch-register.md`'s "Incident/kill-switch
owner" row).

## Webhook recovery after an outage

If the app was down (or `STRIPE_BILLING_ENABLED` was off) for any window, Stripe queues retries for
up to ~3 days per its own dashboard settings, but a genuinely long outage can outlast that. Recovery,
in order:

1. Confirm the app is healthy and `STRIPE_BILLING_ENABLED=true` again.
2. Check `billing_webhook_events` for a backlog: `select status, count(*) from billing_webhook_events
   group by status` — a real gap will show as an elevated `pending` count with old `received_at`
   values (`operations-metrics.ts`'s `webhookAge.oldestPendingMinutes` on `/admin/billing` surfaces
   this directly — alerts at >120 minutes, see `stripe-alerts.md`).
3. Trigger `POST /api/admin/billing/run-worker` (or wait for the next scheduled invocation — there is
   no in-process cron in this bootstrap deployment) to drain the backlog. The worker re-fetches each
   event's FULL object from Stripe by id before processing (`worker.ts`), so a stale queued payload is
   never trusted as-is.
4. For anything Stripe itself gave up retrying (past its own retry window), use the Stripe Dashboard's
   **Developers → Webhooks → [endpoint] → Resend** for the specific missed event ids, or
   **Events → Resend** from the Stripe CLI/API for a bulk resend — the receipt endpoint's
   `(livemode, stripe_event_id)` uniqueness means a resend of an already-processed event is always a
   safe no-op, never a double-apply.
5. Run `pnpm billing:check-readiness` (or wait for the next scheduled `runReconciliation` pass) to
   confirm no lingering `missing_internal`/`stale_internal` drift from the outage window.

## Tabletop exercises

Run these as genuine dry-run walkthroughs (talk through every step out loud with whoever holds each
role, don't skip to "yes that would work") — record the date and participants in the change log at
the bottom of this file once done. These are the four scenarios `stripe-live-readiness.md`'s
`operatorRunbooksConfirmed` gate and `stripe-launch-register.md`'s release-gate checklist require
evidence for.

### 1. Outage (app or database down)

- Who notices first (uptime monitor, customer report, Stripe dashboard alert)?
- Who has authority to flip `STRIPE_BILLING_ENABLED=false`, and how fast can they redeploy?
- Walk through "Webhook recovery after an outage" above once the app is back.
- What do customers see in the interim, once a real Stripe adapter exists and the flag genuinely
  needs to flip off mid-incident? Confirm the checkout/portal UI shows a friendly "billing
  temporarily unavailable" message rather than a raw 500 — this needs a real UI check once that
  adapter lands, since today the flag is never actually flipped off from an "it was on" state in
  production (it has never been on).

### 2. Leaked API/webhook secret

- Walk through `stripe-secret-rotation.md`'s "Compromise rotation" section end to end, out loud,
  timing each step.
- Who has access to the Stripe Dashboard to roll the key?
- Confirm: rolling `STRIPE_SECRET_KEY` has NO overlap window (Stripe deactivates the old key
  immediately) — the deploy that swaps the env var must be ready to go before the key is rolled, or
  every Stripe API call fails in between.

### 3. A webhook event never arrives

- Pick a real event type (e.g. `invoice.paid`) and confirm: what does the organization experience if
  it's simply missing (no credits granted, no receipt) for an hour? For a day?
- Walk through step 2-3 of "Webhook recovery" above to manually trigger a resend for one specific
  event id via the Stripe Dashboard.
- Confirm `reconciliation.ts`'s daily pass would eventually surface the resulting drift
  (`missing_internal` on `payment_intents` for the specific "money collected, no credits issued"
  case) even if the webhook is never recovered — this is the backstop, not the primary path.

### 4. Wrong tax country charged

- A customer is charged with the wrong country's tax rate applied (Stripe Tax misconfiguration, or a
  customer's billing address didn't match the country they were actually in).
- Walk through `stripe-tax.md`'s remediation section.
- Confirm: this requires a REAL refund/reissue through Stripe (this app has no local tax-adjustment
  mechanism) — trace the path through `stripe-refunds.md`'s operator workflow.

## Change log

- 2026-07-24 — Tabletop exercise run (participants: Edd Remonts, Claude). Findings:
  - **Scenario 2 (leaked secret)** was exercised for real, not hypothetically: the live
    `STRIPE_SECRET_KEY` was accidentally exposed via a careless local tool call earlier this session.
    Both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` were rotated in the Stripe Dashboard per
    `stripe-secret-rotation.md`'s "Compromise rotation" section. Confirmed no overlap window on the
    API key (expected) and confirmed via the Stripe Dashboard's own API log that nothing unexpected
    used the key during the exposure window.
  - **Scenario 3 (webhook never arrives)**: walked the reconciliation backstop path for real this
    session via a genuine, previously-undiscovered bug — `POST /api/admin/billing/reconcile`
    authenticated via `CRON_SECRET` was violating `billing_reconciliation_runs.actor_user_id`'s FK
    constraint (fixed in commit `299c9f1`). This is the first time that code path had ever actually
    been exercised end-to-end against a real Postgres instance.
  - **Backup/restore drill** (`stripe-backup-restore.md`'s "Restore rehearsal") was run for real
    against disposable `builderhunt_security_test_*` databases: found the restored-migration-count
    check hardcoded to a stale `29` (real count had grown to 43 without the check being updated —
    fixed in `restore-test.ts` to compare against the source database's own count instead of a magic
    number). After the fix: 43/43 migrations restored, 0 missing RLS policies, billing ledger/grant
    checksum verified byte-for-byte across a real `pg_dump`/`pg_restore` round trip.
  - **This doc itself was stale**: the "Kill switch" section above claimed no real Stripe adapter
    existed and that `STRIPE_BILLING_ENABLED=true` throws — both false as of this session (see
    `real-provider.ts`, certified in `stripe-sandbox-certification.md`). Corrected above.
  - **Scenario 1 (outage) and scenario 4 (wrong tax country)** were walked through on paper only —
    no real production outage or live tax charge exists yet to exercise end-to-end; re-run these two
    once real live traffic exists.
  - Owners for the kill switch and secret rotation are both Edd Remonts (confirmed 2026-07-24).
