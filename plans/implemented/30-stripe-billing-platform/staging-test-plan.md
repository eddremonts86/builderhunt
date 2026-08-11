# Billing Staging Test Plan — Stripe Test Mode Coverage

How the BuilderHunt team exercises the full payment flow end-to-end against
Stripe's test mode (test accounts + test cards + Test Clocks) in the month
before phase-5's switch to `sk_live_`. Companion to `stripe-sandbox-certification.md`
(API-level certification in CI), `stripe-setup-guide.md` (account bootstrap),
`stripe-launch-register.md` (release-gate checklist), and `stripe-live-readiness.md`
(per-gate evidence).

## TL;DR

The base plumbing is in place — `BillingProvider` seam, `RealBillingProvider` +
`FakeBillingProvider`, `E2E_BILLING_SCENARIO` channel, the
`stripe-sandbox-certification` CI job, the catalog with `stripePriceId: { test, live }`,
and `env.ts` rejecting `sk_live_` outside `NODE_ENV=production`. **What is missing
for phase-5** is (1) a populated staging environment pointing at a real Stripe
test account with a real webhook endpoint, (2) a curated mapping of Stripe's
official test cards onto the `BillingScenario` vocabulary the codebase already
uses, (3) extension of `test-clock-lifecycle.test.ts` to cover the 6
time-based scenarios the launch register requires evidence for, and (4) the
`STRIPE mode × DATABASE_URL` runtime invariant in `env.ts` that is not yet
checked.

## 1. What already works (do not rebuild)

| Capability | Where | Status |
| --- | --- | --- |
| `BillingProvider` contract (15 methods) | `src/shared/lib/billing/provider.ts` | stable |
| `FakeBillingProvider` with scenario injection | `src/shared/lib/billing/fake-provider.ts` | stable |
| `RealBillingProvider` against Stripe test API | `src/shared/lib/billing/real-provider.ts` | certified in `real-provider.test.ts` — **7 cases exercising 14 provider methods** against the live test-mode API (re-run 2026-08-03, 7/7 in 15s). Corrected from "15/15 methods": the adapter implements 15, the suite drives 14 of them; `getDefaultPaymentMethodSummary` is the one it does not call directly. |
| `E2E_BILLING_SCENARIO` channel (Redis) | `src/shared/lib/billing/stripe-provider.ts` | stable, used by every e2e billing spec |
| `E2E_MODE=true` short-circuits to fake | `stripe-provider.ts:136` | stable, keeps e2e hermetic |
| `stripe-sandbox-certification` CI job | `.github/workflows/quality.yml` | runs on `STRIPE_SANDBOX_SECRET_KEY`, `continue-on-error: true` |
| Catalog with `stripePriceId: { test, live }` | `src/shared/lib/billing/catalog.ts:79-124` | provisioned, IDs in tree |
| `STRIPE_API_VERSION` pinned to `2026-06-24.dahlia` | `.env.example:140` | matches `stripe@22.3.2` |
| `env.ts` rejects `sk_live_` outside production | `src/shared/lib/env.ts:332` | stable |
| `getStripeClient()` fail-closed | `src/shared/lib/billing/stripe-client.ts:66` | throws on any misconfig |
| `idempotencyKeyFor(...)` everywhere | `stripe-client.ts:122` | all mutating calls have a stable request-level idempotency key |
| Restricted Customer Portal configuration (no plan-switch, no cancel) | `real-provider.ts:308-329` (auto-provisions) | OK |

## 2. What is missing (per environment)

### 2.1 Local dev — `STRIPE_BILLING_ENABLED=false` by default

The fake provider is the day-to-day driver. **No changes needed.** Each dev
does not need a Stripe test account unless they are touching a flow that the
fake cannot exercise (see §5). The default `.env` already reflects this
(`STRIPE_BILLING_ENABLED=false`).

### 2.2 Staging — `STRIPE_BILLING_ENABLED=true`

This is the critical missing piece. One team-owned Stripe test account
(separate from any dev's personal one) with:

- `STRIPE_SECRET_KEY=sk_test_...` in the staging secret manager
- Catalog provisioned (`pnpm stripe:provision --write`)
- A real webhook endpoint at `https://staging.builderhunt.com/api/webhooks/stripe`
  with the event list in §3.1
- The matching `whsec_...` in `STRIPE_WEBHOOK_SECRET`
- A restricted Customer Portal configuration tagged with
  `metadata.builderhunt_restricted_portal = "true"` (the adapter finds it
  idempotently, `real-provider.ts:308`)

**One key set for the whole team** — staging is a shared validation surface,
not per-dev. The dashboard pollutes quickly with per-dev keys and that
defeats its purpose as a "what does the team see" mirror.

### 2.3 CI — same secret as staging

The `stripe-sandbox-certification` job already runs against
`STRIPE_SANDBOX_SECRET_KEY`. Recommendation: **make it the same key as
staging** (rather than a second key). `continue-on-error: true` already
prevents Stripe flakes from blocking merges.

### 2.4 Per-dev — opt-in, for Test Clock experiments

If a dev wants to play with `stripe.testHelpers.testClocks.advance`
locally, they can create their own free test account at
`dashboard.stripe.com/register` (no KYC required for test mode). Zero
cost, zero conflict with staging. Optional — most work does not need it.

## 3. Stripe test cards — official reference mapped to `BillingScenario`

Source: `https://docs.stripe.com/testing`. Any future expiry, any 3-digit CVC,
any ZIP.

### 3.1 Test cards for Checkout (on-session — typed at Stripe's hosted page)

| Card number | `BillingScenario` equivalent | When to use it |
| --- | --- | --- |
| `4242 4242 4242 4242` | `success` | The baseline. Every normal payment. |
| `4000 0027 6000 3184` | `sca_required` | 3DS required — payment stays in `requires_action`; no completion webhook yet. |
| `4000 0027 6000 4823` | `sca_required` (alt) | 3DS required with authentication step. |
| `4000 0000 0000 0002` | `decline` | Generic decline after authentication. |
| `4000 0000 0000 9995` | `decline` (`insufficient_funds`) | Verify the specific `code` propagates. |
| `4000 0000 0000 0069` | `decline` (`expired_card`) | Expired card path. |
| `4000 0000 0000 0127` | `decline` (`incorrect_cvc`) | CVC mismatch. |
| `4000 0000 0000 0119` | `decline` (`processing_error`) | Processing error path. |
| `4000 0000 0000 0341` | `attach_fails` | Attach fails, then declines. |
| `4000 0025 0000 3155` | `requires_payment_method` | Attaches but cannot charge. |

### 3.2 PaymentMethod tokens for off-session (auto-recharge, SetupIntents)

These are the tokens the codebase uses today, listed with their scenarios
and the **known caveat** the sandbox-certification doc already calls out
(`stripe-sandbox-certification.md:54-57`):

| Token | Scenario | Notes |
| --- | --- | --- |
| `pm_card_visa` | success | Default for `real-provider.test.ts` and `test-clock-lifecycle.test.ts`. |
| `pm_card_visa_chargeDeclined` | decline (off-session) | **Use this one** for off-session decline testing. |
| `pm_card_authenticationRequired` | `sca_required` (off-session) | Validates auto-recharge pause → portal recovery (`auto-recharge.ts:273`). |
| `pm_card_chargeDeclined` | decline | **Known broken** — fails at `paymentMethods.attach` in this API version (`stripe-sandbox-certification.md:54-57`). Do not use in new tests. |

### 3.3 Webhook subscription list (staging webhook endpoint)

The staging webhook must subscribe to **all** of these (matches the
`processStripeWebhookEvent` switch in `webhook-handlers.ts:102-148`):

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.requires_action`
- `refund.updated`
- `refund.failed`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- `charge.dispute.funds_reinstated`

`refund.created` and `charge.refunded` are intentionally NOT subscribed —
the codebase already records refunds synchronously the moment it sends them
to the provider (`refunds.ts`'s `processPendingPackRefund`), and
`refund.updated` / `refund.failed` carry the only actionable status
transitions. The handler returns `{ outcome: 'ignored', ... }` for those
two as documented (`webhook-handlers.ts:129-135`).

### 3.4 Forcing refunds and disputes in test mode

| Mechanism | How to force it in test mode |
| --- | --- |
| **Refund (succeeded)** | Dashboard → PaymentIntents → pick the one → "Refund" → confirm. `refund.updated` lands in seconds. |
| **Refund (failed)** | Dashboard → Refunds → pick the pending one → "Mark as failed" (or trigger via test-mode failure path on the PaymentIntent). |
| **Dispute created** | Dashboard → PaymentIntents → "Simulate a dispute" (or `stripe trigger charge.dispute.created` from the CLI). |
| **Dispute closed as `won`** | Dashboard → Disputes → pick the open one → "Mark as won". |
| **Dispute closed as `lost`** | Dashboard → Disputes → pick the open one → "Mark as lost". |
| **Funds reinstated** | Dashboard → Disputes → pick the lost one → "Reinstate funds" (test-mode only). |

## 4. Flow-by-flow coverage matrix

The "Real coverage" column marks ✅ where the flow has a passing test
against the real Stripe test-mode API, ⚠️ partial, ❌ fake-only (or
nothing).

### 4.1 Subscription (Pro / Pro Max / Team)

| Flow | Real coverage | Card / mechanism | Verify |
| --- | --- | --- | --- |
| Checkout + activation | ❌ | `4242 4242 4242 4242` | `checkout.session.completed` → `customer.subscription.created` → first monthly credit grant in `billing_credit_grants` |
| Checkout with 3DS | ❌ | `4000 0027 6000 3184` | Stays in `requires_action`; **no** `billing_subscriptions` row yet |
| Decline at checkout | ❌ | `4000 0000 0000 0002` | No `checkout.session.completed` webhook; no `billing_subscriptions` row |
| Monthly renewal (success) | ⚠️ partial — `test-clock-lifecycle.test.ts` has 1 happy path with Test Clock | `4242` + Test Clock + advance 1 month | `invoice.paid` arrives; **idempotent** second grant attempt with the same `monthlyWindowKey` is a no-op |
| Renewal with decline | ❌ | `4242` + Test Clock + swap PM to `4000 0000 0000 0002` + advance | `invoice.payment_failed` → `past_due` → 7-day grace (`dunning.ts`) |
| Upgrade Pro → Pro Max | ❌ | `4242` + Test Clock | `customer.subscription.updated` with proration; `previewSubscriptionChange` returns non-zero `amountDue` |
| Downgrade Pro Max → Pro | ❌ | `4242` + Test Clock | Same as upgrade, opposite direction; verify delta credits applied |
| Cancel at period end | ❌ | `4242` | `cancel_at_period_end: true`; subscription stays `active` until period end, then `canceled` |
| Cancel immediate | ❌ | `4242` | `customer.subscription.deleted` → status `canceled` |
| Annual grant anniversary | ❌ | `4242` + Test Clock + advance 1 year | `annual_grants.ts` creates a new annual grant; idempotent on re-arrival |

### 4.2 Credit pack (one-shot `mode: 'payment'`)

| Flow | Real coverage | Card | Verify |
| --- | --- | --- | --- |
| Pack purchase (success) | ❌ | `4242` | `checkout.session.completed` (mode `payment`) → `grantCredits` with `source: 'pack'`, `units = pack.credits`, 12-month expiry |
| Pack decline | ❌ | `4000 0000 0000 0002` | No completion webhook → no grant row |
| Pack blocked without active subscription | ❌ | N/A (gate is server-side) | `isActivePaidSubscription` check returns `no_active_subscription` before session creation |
| Rolling risk limit (3 charges / $1000 / 24h) | ❌ | `4242` × 4 in 24h | 4th attempt returns `risk_limit_exceeded`; shared with auto-recharge |
| Pack with promotion code attempted | N/A | N/A | Server hardcodes `allowPromotionCodes: false` (`packs.ts`); the field is not exposed |

### 4.3 Auto-recharge (off-session PaymentIntent)

| Flow | Real coverage | Card / PM | Verify |
| --- | --- | --- | --- |
| Setup with success | ❌ | `pm_card_visa` | `setupIntent` returns `succeeded`; rule state `active` |
| Trigger when balance below threshold | ❌ | `pm_card_visa` | Sweep creates off-session `PaymentIntent` → `payment_intent.succeeded` → grant; rule reactivated |
| Trigger with off-session decline | ❌ | `pm_card_visa_chargeDeclined` | Rule → `paused_failed`; no grant |
| Trigger with 3DS required | ❌ | `pm_card_authenticationRequired` | Rule → `paused_needs_auth`; UI surfaces "needs authentication" and links to Customer Portal |
| Trigger with rolling risk limit | ❌ | N/A | After 3 successful charges in 24h, sweep decides "over cap" and does not fire |
| Recovery via portal after pause | ❌ | new `pm_card_visa` in portal | Rule reactivated, next sweep succeeds |

### 4.4 Customer Portal

| Flow | Real coverage | Verify |
| --- | --- | --- |
| Create portal session | ❌ | URL generated; the configuration object used carries `subscription_update: false` and `subscription_cancel: false` (asserted in `real-provider.test.ts`) |
| Update payment method in portal | ❌ | New default PM on Customer object; subscription unaffected |
| Portal hides plan-switch and cancel | ❌ | Configuration restricts the owner; verify in the live Stripe dashboard that the buttons are absent |

### 4.5 Refund

| Flow | Real coverage | Mechanism | Verify |
| --- | --- | --- | --- |
| Refund pack (full) | ❌ | Dashboard → Refund succeeded | `refund.updated` succeeded → `applyCreditRevocationForRefund` revokes the linked pack grant |
| Refund pack (partial) | ❌ | Dashboard → Refund succeeded with amount | Same path, partial `unitsDelta` |
| Refund failed | ❌ | Dashboard → Mark refund failed | `refund.updated` failed → `updateBillingRefundState` → state `failed` |
| Subscription invoice refund | N/A | N/A | Subscription refunds are out of the pack grant reconciliation path (`refunds.ts` and `disputes.ts` module comments) |

### 4.6 Dispute (chargeback)

| Flow | Real coverage | Mechanism | Verify |
| --- | --- | --- | --- |
| Dispute created | ❌ | Dashboard → Simulate dispute | `charge.dispute.created` → grant frozen; `billing_disputes` row created |
| Evidence deadline updates | ❌ | Dashboard → set evidence due-by | `charge.dispute.updated` with new `evidence_details.due_by`; row synced |
| Dispute won | ❌ | Dashboard → Mark as won | `charge.dispute.closed` outcome `won` → grant restored |
| Dispute lost | ❌ | Dashboard → Mark as lost | `charge.dispute.closed` outcome `lost` → grant revoked (via dispute resolution, distinct from refund path) |
| Funds reinstated after loss | ❌ | Dashboard → Reinstate funds | `charge.dispute.funds_reinstated` → accounting row only; **does not** reverse the revocation (see `disputes.ts` module comment) |
| Subscription-invoice dispute | N/A | N/A | Stays `deferred` in the inbox by design — not in this task's scope (`webhook-handlers.ts:341`) |

### 4.7 Credit consumption ("token reduction")

| Flow | Real coverage | Where | Verify |
| --- | --- | --- | --- |
| Reserve before use | ✅ e2e fake (`tests/e2e/billing-credits.spec.ts`) | `reservations.ts` | Reserves the rate-card ceiling before the call |
| Settle on completion | ✅ e2e fake | `reservations.ts` | Settles actual usage; releases the difference |
| FIFO by earliest expiry | ✅ unit | `credits.ts:282` `getAvailableCreditGrantsByEarliestExpiry` | Earliest-expiring grant is consumed first |
| Mix of subscription + pack grants | ❌ | manual staging | A pack grant (12 months) and a subscription monthly grant coexist; subscription-monthly must be drawn first because it expires sooner |
| Tier gate (Pro+) and credit gate (balance>0) produce distinct refusals | ✅ e2e fake | `billing-credits.spec.ts` | Asserts 402 vs 403 are distinguishable |

## 5. Test Clocks — scenarios still to certify

> **Closed 2026-08-03: `test-clock-lifecycle.test.ts` is 7/7 against the real test-mode API.** Four of the six
> below were implemented; the other two needed a decision rather than code, recorded here rather than silently
> skipped.
>
> **Implemented** — §5.1 monthly anniversary (two consecutive advances, three distinct contiguous billing
> windows), §5.2 annual anniversary (2026-01-15 → 2027-01-15, same calendar date), §5.5 trial-to-active
> conversion with a real non-zero invoice, §5.4 dunning (a card that still declines never reads `active` again,
> and leaves an unpaid invoice behind).
>
> **§5.3 leap year / month-end: already certified**, by the pre-existing "Jan 31 → Feb 28" case. A second copy
> with a different start date would add a minute of network runtime and no evidence.
>
> **§5.6 dispute: not a Test Clock concern, and this document contradicts itself about it.** A dispute is not a
> time-based event — nothing advances a clock to produce one. The assertion §5.6 actually asks for ("the linked
> pack grant is revoked but the subscription itself is unaffected, per `disputes.ts`") is our own code's
> response to a `charge.dispute.*` webhook, and `tests/unit/shared/lib/billing/disputes.test.ts` covers it
> deterministically in 14 tests, including duplicate-delivery idempotency and the no-linked-grant case. §9 of
> this very document also says **"Do not automate disputes and refunds through scripts"** — so §5.6 asks for
> exactly what §9 forbids. §9 is right; §5.6 should be read as "dispute handling needs evidence", which it has.
>
> **One finding worth keeping.** §5.1's first version asserted distinct `invoice.period_start` values and failed
> with "expected 2 to be 3". Probing the real objects showed the creation invoice's own period is a *zero-length*
> window at the creation instant, colliding with the first cycle invoice's start; the real service window lives
> on the **line item**, and Stripe bills in advance. A grant-window derivation reading `invoice.period_start`
> would look correct and be wrong.

Today `test-clock-lifecycle.test.ts` covers 3 cases (create + renew + upgrade
+ downgrade + cancel — all with `pm_card_visa`). The launch register
(`stripe-launch-register.md`) requires evidence for the full set below. Each
test must create its own `testHelpers.testClocks.create(...)` and rely on
`afterEach` deletion to cascade-clean all attached customers/subscriptions
(no manual Dashboard cleanup).

1. **Monthly grant anniversary** — start at `2026-01-15`, advance to
   `2026-02-15`, then `2026-03-15`. Verify the second advance either grants
   or re-keys the next window correctly (whichever the catalog's
   `monthlyWindowKey` derivation does), and that a duplicate webhook from
   the same renewal is a no-op.
2. **Annual grant anniversary** — start at `2026-01-15`, advance to
   `2027-01-15`. Verify `annual_grants.ts` creates the year-1 grant and a
   re-arrival does not double-grant.
3. **Leap year and month-end** — start at `2027-01-31`, advance 1 day, then
   1 month. Verify the next billing cycle anchor is `2027-02-28` (not
   `2027-03-03`).
4. **Past-due + grace period** — start active, advance to renewal, swap
   the default PM to a decline card (`4000 0000 0000 0002`), advance 1 day
   past renewal, advance 7 more days. Verify the subscription reaches
   `canceled` after the documented 7-day grace.
5. **Trialing** — create the subscription with `trial_period_days: 7`,
   advance 8 days. Verify the first `invoice.paid` lands and the
   trial-to-active transition occurs.
6. **Dispute during an active subscription period** — create an active
   subscription, simulate a dispute on a previous pack invoice, close it
   as `lost`. Verify the linked pack grant is revoked but the
   subscription itself is unaffected (per `disputes.ts`).

## 6. Staging environment setup (5 steps, ~30 minutes)

1. **Create the test Stripe account.** One person signs up at
   `dashboard.stripe.com/register` (free, no KYC, test mode only).
2. **Provision the catalog.**
   ```bash
   STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision --write
   git diff src/shared/lib/billing/catalog.ts   # review
   ```
   This creates 6 subscription Prices + 3 pack Prices and patches the
   `stripePriceId.test` columns. (Already done in the current tree per
   `catalog.ts:79-124` — re-run only if the catalog drifts.)
3. **Create the webhook endpoint.** Dashboard → Developers → Webhooks →
   Add endpoint. URL: `https://staging.builderhunt.com/api/webhooks/stripe`.
   Subscribe to the event list in §3.1. Copy the signing secret into the
   staging secret manager as `STRIPE_WEBHOOK_SECRET`.
4. **Create the restricted Customer Portal configuration.** Dashboard →
   Settings → Billing → Customer portal → New configuration. Tag it with
   `metadata.builderhunt_restricted_portal = "true"`. Restrict features to
   `payment_method_update`, `customer_update (address, tax_id)`,
   `invoice_history`. **Disable** `subscription_update` and
   `subscription_cancel`. (The adapter auto-finds this configuration by
   metadata; `real-provider.ts:308-329`.)
5. **Wire the staging env.** Set in the staging secret manager:
   - `STRIPE_BILLING_ENABLED=true`
   - `STRIPE_SECRET_KEY=sk_test_...` (the team-owned key)
   - `STRIPE_WEBHOOK_SECRET=whsec_...`
   - `STRIPE_API_VERSION=2026-06-24.dahlia`
   - `WEBHOOK_PAYLOAD_ENCRYPTION_KEY=<64 hex chars>` (`openssl rand -hex 32`)

After step 5, every deploy to staging runs against the real test-mode API
end-to-end. Webhooks arrive at the staging URL within seconds of every
test-mode action.

## 7. The cross-check gap in `env.ts`

> **Closed 2026-08-03.** Implemented in `src/shared/lib/env.ts` with `DB_ENV_MARKER`, exactly as specified
> below — a declared marker rather than a substring match, both directions failing closed at boot, and absent
> treated as "not production" so a missing marker can only ever *refuse* a live key.
>
> Verified through the real parser across all four pairings: `live + staging` REFUSED, `test + production`
> REFUSED, `live + production` BOOTS, `test + development` BOOTS. Six cases added to
> `tests/unit/shared/lib/env.security.test.ts` (86 passing).
>
> **Operational consequence, stated because it is a deploy-time behaviour change:** a production deployment that
> switches to `sk_live_` without `DB_ENV_MARKER=production` will now **fail to start**. That is the intended
> trade — the alternative is charging real cards against a database the production ledger does not read.
> `.env.production.example` sets it and says so; production today runs `STRIPE_BILLING_ENABLED=false` with no
> key, so nothing changes until the phase-5 switch.

`env.ts:332` correctly rejects `sk_live_` outside `NODE_ENV=production`.
**It does not** validate that an `sk_test_` key is paired with a non-prod
`DATABASE_URL`, or that an `sk_live_` key is paired with a prod database.

Concrete risk: a dev with `.env` containing `sk_test_` accidentally
pointing at the prod DB will pollute real customers; staging with
`sk_live_` by copy-paste will charge real cards during a demo.

**Fix (small, high-value, ~15 lines in `env.ts`):** fail-closed at boot
when the Stripe key mode and the database URL marker do not agree. Two
directions, both abort with an explicit message:

- `STRIPE_SECRET_KEY` starts with `sk_live_` AND
  `DATABASE_URL` does NOT contain a prod marker (e.g. lacks `production`)
  → reject.
- `STRIPE_SECRET_KEY` starts with `sk_test_` AND
  `DATABASE_URL` contains a prod marker → reject.

Acceptable "prod markers" should be explicit (e.g. an env var
`DB_ENV_MARKER` that production sets to `production`); do not rely on
substring matching of the connection string host. The exact mechanics
should match `env.ts`'s existing `context.addIssue` pattern.

## 8. Weekly plan to phase-5

| Week | Action | Owner |
| --- | --- | --- |
| 0 (now) | Create team-owned Stripe test account, provision catalog, create webhook endpoint and portal configuration, wire staging secrets | 1 dev |
| 0 | Implement the `STRIPE mode × DATABASE_URL` cross-check in `env.ts` | 1 dev |
| 1 | Smoke test the §4.1 (subscription) and §4.2 (pack) flows in staging with the cards in §3.1; capture any webhook payload mismatches | 1-2 devs |
| 1-2 | Extend `test-clock-lifecycle.test.ts` with the 6 scenarios in §5 | 1 dev |
| 2-3 | Smoke test the §4.3 (auto-recharge) flows with the PM tokens in §3.2 | 1-2 devs |
| 3-4 | Smoke test the §4.5 (refund) and §4.6 (dispute) flows using the dashboard-driven mechanisms in §3.4 | 1-2 devs |
| 4 (phase-5) | `pnpm billing:check-readiness --confirm-*` with real evidence → flip `STRIPE_BILLING_ENABLED=true` on production with `sk_live_` | the team |

## 9. What NOT to do

- **Do not** create per-dev Stripe test accounts as a default. 90% of work
  is validated with the fake. Only the dev touching a flow the fake cannot
  cover needs a personal `sk_test_`.
- **Do not** automate disputes and refunds through scripts that drive
  the Dashboard. Test mode has the UI; using it manually in staging is
  faster than maintaining a brittle script.
- **Do not** skip the §4 matrix "because the fake already covers it". The
  fake validates logic; the real validates integration. The
  `stripe-sandbox-certification.md` doc is explicit about this distinction.
- **Do not** use `pm_card_chargeDeclined` in new tests. The
  sandbox-certification doc already documents that it fails at
  `paymentMethods.attach` in this API version. Use
  `pm_card_visa_chargeDeclined` for off-session and
  `4000 0000 0000 0002` for on-session.
- **Do not** put a "test mode" toggle in the product UI. Test mode is
  infra, not a feature; the end user should never see "sandbox" anywhere.
- **Do not** clone the production DB into Stripe. The `livemode` flag on
  every Stripe object is the single source of truth; the catalog already
  separates `test` and `live` Price IDs at the application layer.

## 10. Open questions for the team

1. Is the team's primary Stripe work today driven through the fake
   (most iterations) or the real test-mode API (sandbox-cert only)? This
   determines whether `STRIPE_BILLING_ENABLED=true` should be the default
   in staging or stay opt-in.
2. Are there any current previews / demo environments that need their
   own Stripe test account (separate from staging)? If yes, that
   accelerates the "multi-account" question.
3. Which dev is the natural owner for the `env.ts` cross-check? It is
   small and isolated but touches a hot path.

## 11. Related docs

- `stripe-setup-guide.md` — full account bootstrap (steps 0-7)
- `stripe-sandbox-certification.md` — API-level CI certification
- `stripe-launch-register.md` — phase-5 release-gate checklist
- `stripe-live-readiness.md` — `pnpm billing:check-readiness` and its gates
- `stripe-webhooks.md` — webhook handler outcomes (`applied` /
  `ignored` / `deferred`)
- `stripe-refunds.md` — refund flow specifics
- `stripe-disputes.md` — dispute flow specifics
- `stripe-customer-portal.md` — portal configuration
- `stripe-tax.md` — Stripe Tax setup
- `stripe-secret-rotation.md` — rotating `STRIPE_WEBHOOK_SECRET` /
  `WEBHOOK_PAYLOAD_ENCRYPTION_KEY`
- `stripe-incident-response.md` — kill switch (`STRIPE_BILLING_ENABLED=false`)
