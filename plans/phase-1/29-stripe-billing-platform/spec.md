# Stripe Billing Platform

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md),
> [`team-accounts`](../26-team-accounts/spec.md)
> **Blocks**: [`calendar-scheduling-interview-intelligence`](../43-calendar-scheduling-interview-intelligence/spec.md)
> **Reality check**: BuilderHunt already has organization entitlements and manual plan history in
> `src/shared/lib/db/schema.ts`, `src/shared/lib/repositories/entitlements.ts`,
> `src/shared/lib/repositories/platform-billing.ts`, `/api/plans/me`, and `/settings/billing`. It has
> no Stripe dependency, checkout, portal, webhook inbox, payment lifecycle, internal credit ledger,
> refund/dispute automation, or financial reconciliation. The legacy `plans` table remains only for
> migration evidence and cannot become the Stripe authority.

## Source design

The approved design is
[`docs/superpowers/specs/2026-07-21-stripe-billing-platform-design.md`](../../../docs/superpowers/specs/2026-07-21-stripe-billing-platform-design.md).
This spec and `tasks.md` are the executable contract. The source design records product rationale.

## Problem

Manual admin-approved tiers cannot support self-service subscriptions or protect BuilderHunt from
provider costs. The interview program requires prepaid, synchronous authorization, while Stripe
subscription and payment state is asynchronous, retryable, and sometimes out of order. A thin
Checkout integration would create duplicate-grant, proration, tax, refund, dispute, and tenant-
ownership risks.

## Goal

Build one reusable organization-owned billing control plane. Stripe handles card collection,
authentication, invoices, tax calculation, payment methods, and refunds. BuilderHunt owns catalog
policy, organization permissions, entitlements, credits, real-time authorization, and audit.

## Non-goals

- Stripe Connect, marketplace payments, payouts to users, or revenue sharing.
- More than one base subscription per organization.
- Stripe metered billing or Stripe Billing Credits as authorization.
- Transferable, cashable, or customer-defined credits.
- Public card trials, bank debit, bank transfer, BNPL, or delayed payment methods at launch.
- Automatic EU-wide launch, automatic tax registration, or tax/legal advice.
- Storing card or bank credentials in BuilderHunt.

## Commercial contract

All amounts are USD and displayed as excluding applicable tax. Clients submit catalog keys only.

| Tier    | Monthly | Annual | Included credits per monthly window | Seats |
| ------- | ------: | -----: | ----------------------------------: | ----: |
| Free    |      $0 |      — |                                   0 |     1 |
| Pro     |     $19 |   $182 |                                 140 |     1 |
| Pro Max |     $79 |   $758 |                                 700 |     1 |
| Team    |    $199 | $1,910 |                        2,100 pooled |    10 |

| Pack key      | Price | Credits |    Expiry |
| ------------- | ----: | ------: | --------: |
| `starter_300` |   $15 |     300 | 12 months |
| `scale_1000`  |   $45 |   1,000 | 12 months |
| `max_5000`    |  $299 |   5,000 | 12 months |

- Each tier/interval and pack maps to an immutable Stripe Product/Price. Price changes create a
  catalog version and new Price IDs.
- Existing subscribers retain their contracted price until the next eligible renewal. Increases
  receive at least 30 days' notice; annual prices remain unchanged through the paid year.
- Team includes 10 fixed seats. Accepted members and usable invitations consume seats. No quantity
  or additional-seat Price exists at launch; the eleventh seat is blocked.
- Packs require an active Pro, Pro Max, or Team entitlement to buy or consume. Suspension preserves
  their original 12-month expiry but makes them unusable until paid reactivation.
- Subscription promotion codes are allowed with product, customer, redemption, and date limits.
  Packs do not accept promotion codes.
- No public automatic trial. Platform operators may create audited manual trials or promo grants.

## Ownership and authorization

- One Stripe Customer and at most one non-terminal base subscription exist per organization and
  Stripe livemode.
- Personal subscriptions belong to the user's personal organization, never directly to a user.
- Only the organization `owner` can start Checkout, change/cancel a subscription, open payment-
  method Portal, buy packs, enable auto-recharge, request refunds, or modify billing contacts.
- Organization `admin` can read plan, invoices, usage, balance, seats, and payment status. It cannot
  cause a charge. Members see feature availability and an owner-contact action only.
- Platform billing operators use the existing platform-admin authority, recent authentication, and
  audited purpose-specific endpoints; no organization role grants platform authority.

## Domain boundaries

- `billing/catalog`: catalog keys, immutable versions, Stripe mappings, tax behavior, and validation.
- `billing/subscriptions`: Checkout, preview, proration, renewal, scheduled changes, cancellation,
  grace, and entitlement projection.
- `billing/payments`: Customer Portal, pack Checkout, auto-recharge, refunds, and disputes.
- `billing/credits`: grants, reservations, allocations, settlement, expiry, freeze, and corrections.
- `billing/webhooks`: raw signature verification, durable inbox, replay, and monotonic handlers.
- `billing/reconciliation`: provider comparison, repair cases, settlement facts, and accounting export.
- `billing/configuration`: private seller profile, country allowlist, launch gates, and provider checks.
- `team-accounts`: organization/member/invitation management and authoritative seat count.
- Feature plans: define versioned operation rate cards and call generic reserve/settle contracts.

## Data model

The next available migration is expected after the current uncommitted `0019`; implementation must
generate a new migration and never overwrite another workstream's migration. Tenant-private tables
use organization-preserving foreign keys, RLS, and server-resolved tenant context. Platform/system
tables are inaccessible to browser roles and use restricted repositories.

| Table                         | Class and required invariants                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing_customers`           | Tenant-private; unique `(organization_id, livemode)` and unique Stripe Customer ID.                                                                                                                      |
| `billing_subscriptions`       | Tenant-private; unique active base subscription per org/livemode; catalog tier/interval/version, Stripe IDs/status, paid period, scheduled action, grace/block timestamps, monotonic provider timestamp. |
| `billing_checkout_attempts`   | Tenant-private; owner actor, action/catalog key, stable idempotency key, consent versions, Checkout Session, state, expiry.                                                                              |
| `billing_webhook_events`      | System operational; unique `(livemode, stripe_event_id)`, API version, object/type, receipt/process state, attempts, next attempt, minimized encrypted payload, redacted error.                          |
| `billing_credit_grants`       | Tenant-private; source/type, original/remaining integer units, active/expiry dates, state, Stripe payment/invoice reference, unique monthly-window key.                                                  |
| `billing_credit_reservations` | Tenant-private; operation/rate-card version, max/settled units, heartbeat/deadline/state, unique org/idempotency key.                                                                                    |
| `billing_credit_allocations`  | Tenant-private; reservation-to-grant slices; allocated/consumed units cannot exceed grant or reservation.                                                                                                |
| `billing_ledger_entries`      | Tenant-private, append-only; grant/reserve/release/consume/expire/freeze/unfreeze/revoke/adjust; unique source idempotency reference.                                                                    |
| `billing_provider_usage`      | Tenant-private; operation/provider request, units, estimated/actual cost and currency, settlement/reconciliation state.                                                                                  |
| `billing_auto_recharge_rules` | Tenant-private; owner consent, pack, threshold, monthly cap, state, last failure; one active rule per org.                                                                                               |
| `billing_refunds`             | Tenant-private plus operator fields; policy decision, provider refund, revised service end, credit revocation, state, idempotency.                                                                       |
| `billing_reconciliation_runs` | System operational; time window, counts, mismatches, repairs, result and actor.                                                                                                                          |
| `billing_seller_profiles`     | Platform-private; versioned public seller identity, country/tax allowlists and effective dates; no CPR/card/bank data.                                                                                   |
| `billing_terms_acceptances`   | Tenant-private; owner, document versions, commercial action, Checkout/auto-recharge reference, timestamp and minimal evidence.                                                                           |

All unit and money quantities are integers in smallest units. Ledger entries are never updated or
deleted; mistakes use compensating entries. Database checks prohibit negative units, invalid state
values, allocation over-consumption, and mixed-organization references.

## Subscription state machine

### Creation and renewal

1. Owner selects a server catalog key and accepts versioned terms.
2. Server creates/reuses the organization Customer and a stable checkout attempt.
3. Checkout uses subscription mode, automatic tax, billing address, tax-ID collection, customer
   updates, approved immediate card/wallet methods, and allowlisted URLs.
4. Redirect success remains `pending`; only verified provider state activates access.
5. `invoice.paid` activates/renews the entitlement and grants included credits exactly once.

Monthly subscriptions grant on each paid invoice. Annual subscriptions grant the first monthly
window on the paid annual invoice; a daily idempotent worker grants the remaining 11 windows on
calendar anniversaries of the billing anchor, clamped to month end. Each grant expires at the next
anniversary and is unique by subscription/window/type.

### Changes

- Upgrade: preview exact Stripe invoice/tax, then use immediate proration and pending update. Apply
  only after successful payment. Add
  `ceil((new allowance - old allowance) * remaining seconds / window seconds)` credits expiring at
  the current window end.
- Monthly to annual at same tier: immediate after preview; unused monthly time is credited, annual
  charge succeeds, current credit window remains, and no duplicate grant occurs.
- Downgrade, cancellation, or annual to monthly: schedule for Stripe billing-period end. An annual
  customer remains contracted through the annual end, not the monthly credit anniversary.
- Team to one-seat tier: do not send Stripe change while accepted members plus usable invitations
  exceed one. Link exact owner-visible blockers to `/settings/team`; never evict automatically.

### Failed payments and disputes

The first renewal failure starts seven calendar days of grace. Configure Stripe retries inside that
window. Access and credits continue during grace. After grace, an idempotent worker sets
`payment_blocked`, blocks new premium work, freezes included grants, preserves purchased grants but
makes them unusable, and preserves all data/export access. Recovery unfreezes still-valid grants.

A subscription chargeback bypasses grace, immediately blocks new premium work, and freezes linked
included grants. Winning restores still-valid state; losing ends paid entitlement and revokes unused
linked credits. Unrelated purchased grants remain recorded. Pack disputes freeze/revoke only their
linked grant.

## Credit authorization contract

Feature code cannot read balances and call providers directly. It uses:

```ts
checkEntitlement({ organizationId, feature });
reserveCredits({ organizationId, operation, maximumUnits, idempotencyKey });
extendReservation({ reservationId, additionalMaximumUnits, idempotencyKey });
settleReservation({ reservationId, actualUnits, providerReference });
releaseReservation({ reservationId, reason });
refundUsage({ settlementId, units, reason, idempotencyKey });
```

Reservation is transactional and lock-protected, consumes the earliest-expiring eligible grants,
and never permits negative available balance. The exact grant slices remain attached to the
reservation. Settlement consumes actual units and releases the remainder; provider failure releases
all. A provider-backed operation cannot begin before reservation success.

A valid reservation protects its allocation through the operation's server-defined maximum
duration plus settlement grace even if the grant expires. Unused units released after original
expiry expire immediately. Client input cannot extend operation limits or turn reservation into
rollover.

## Packs and auto-recharge

- Pack Checkout uses payment mode and active-paid-entitlement validation before creation and grant.
- Auto-recharge is off by default, owner-only, and requires separate versioned off-session consent.
- Owner chooses pack, balance threshold, and monthly cap up to $1,000.
- Manual and automatic pack charges share a rolling limit: at most three successful charges or
  $1,000 in 24 hours, whichever comes first.
- Provider-requested 3DS, Radar, failure/card-rotation velocity checks, and a reviewed time-bounded
  high-volume exception protect against spend-then-chargeback abuse.
- Authentication-required or failed off-session payment pauses auto-recharge and sends the owner to
  an on-session recovery. No credits exist before payment success.

## Refund contract

- Cancellation is prospective with no automatic refund. Legal/support exceptions are audited.
- Full unused pack: full refund plus revocation of its grant.
- Partially used pack: no self-service; support may approve proportional refund and revoke only
  corresponding unconsumed units.
- Full subscription-invoice refund: paid period ends immediately and unused included credits sourced
  from that invoice are revoked. Purchased packs remain unchanged.
- Partial subscription refund: operator must set revised service end; preview shows entitlement and
  credit effects before confirmation.
- Stripe refund and compensating internal effects use one idempotent state machine. Partial failure
  becomes a visible repair case and blocks conflicting mutations.

## Checkout, Portal, consent, and billing contact

Checkout requires current Terms and Privacy Policy acceptance and discloses renewal, amount,
interval, cancellation/refund policy, credit expiry/non-transferability, tax, and total. Store
document versions, owner, organization, timestamp, Checkout Session, and minimal evidence. Material
changes require fresh acceptance; auto-recharge has separate consent.

Customer Portal is owner-only and limited to payment methods, tax identity, invoices, and receipts.
All plan changes/cancellation remain BuilderHunt-owned. A verified billing email can receive
financial notices but gains no membership or authority; critical notices also reach the owner.

Ownership transfer preserves the organization Customer, subscription, and corporate payment method.
The transfer preview shows masked method, next charge date, and expected pre-tax amount. The new
owner gains billing authority immediately, the old owner loses it, and both are notified. The old
owner can replace a personal method before transfer but is not forced to replace a company card.

## Organization deletion

Normal deletion request immediately prevents renewal, keeps access through the paid end, then runs
product-data deletion. Immediate deletion cancels now and, after explicit warning, forfeits access
and remaining credits without automatic refund. Only legally required invoice, tax, payment, refund,
dispute, and audit records survive under the approved financial retention schedule. Canceling a
delayed deletion never silently restores renewal.

## Seller, country, currency, and tax configuration

- Initial seller classification: Denmark-established individual. Personal identity is provided
  directly to Stripe KYC; CPR is never committed, stored by BuilderHunt, or displayed publicly.
- Initial production customer-country allowlist: Denmark only. EU scenarios run in sandbox but
  production countries require individual VAT/OSS approval and Stripe Tax registration evidence.
- All prices/charges/invoices/refunds are USD. BuilderHunt does no customer currency conversion.
  Stripe owns payout setup; reconciliation stores only currency, rate, fee, and net settlement facts.
- A platform-admin configuration stores versioned public seller name/address, approved CVR/VAT IDs,
  support contact, statement descriptor, countries, registrations, and effective dates. Provider-
  owned Stripe Dashboard settings remain explicit runbook steps and are reconciled.
- Production charges require `charges_enabled`, completed Stripe KYC, a valid public business
  profile, tax/product code decision, refund treatment, and Danish registration/VAT review. Stripe
  calculation does not replace registration, filing, or remittance.

## API contract

All organization routes resolve the active tenant from session, reject client organization IDs,
validate with Zod, enforce owner/read permissions server-side, require same-origin/CSRF controls for
cookie mutations, rate-limit, and return allowlisted DTOs.

| Route                                       | Authority             | Purpose                                                                                  |
| ------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/billing/summary`                  | member/read policy    | Entitlement, seats, balance/grants, usage, invoices, scheduled state, role capabilities. |
| `POST /api/billing/checkout/subscription`   | owner                 | Create idempotent subscription Checkout from catalog key and consent versions.           |
| `POST /api/billing/checkout/credits`        | owner + active paid   | Create pack Checkout after velocity checks.                                              |
| `POST /api/billing/portal`                  | owner                 | Create restricted Customer Portal session.                                               |
| `POST /api/billing/subscription/preview`    | owner                 | Return provider-backed charge/tax/date/credit/seat preview.                              |
| `POST /api/billing/subscription/change`     | owner                 | Apply immediate paid upgrade or schedule downgrade/cadence change.                       |
| `POST /api/billing/subscription/cancel`     | owner                 | Schedule cancellation at period end.                                                     |
| `PUT /api/billing/auto-recharge`            | owner                 | Validate/store/disable rule and consent.                                                 |
| `POST /api/billing/refunds`                 | owner                 | Submit eligible unused-pack request; never directly decide exception.                    |
| `POST /api/webhooks/stripe`                 | Stripe signature      | Raw-body verification and durable idempotent receipt.                                    |
| `POST /api/admin/billing/run-worker`        | platform worker/admin | Process inbox, grants, grace, expiry, notifications, auto-recharge, repair retries.      |
| `POST /api/admin/billing/reconcile`         | platform admin/cron   | Compare Stripe and internal financial state.                                             |
| `POST /api/admin/billing/events/:id/replay` | platform admin        | Audit and replay one normalized event idempotently.                                      |
| `GET/PUT /api/admin/billing/configuration`  | platform admin        | Read/update versioned seller and launch configuration.                                   |
| `GET/POST /api/admin/billing/refunds`       | platform admin        | Review, preview, decide, and repair refunds/disputes.                                    |

## Webhook and consistency contract

The webhook reads raw bytes, verifies `Stripe-Signature` using current/rotating endpoint secrets,
rejects livemode/API-version mismatch, stores the unique event durably, and returns quickly. It may
attempt immediate processing; the existing HTTP-cron worker replays pending/failed rows. Unknown
events are safe ignored records.

Delivery order is not trusted. Handlers retrieve current provider objects where needed and apply
monotonic transitions. Duplicate events are successful no-ops. Every Stripe POST has a stable
operation key and recorded Stripe request ID. SDK, account, webhook endpoint, fixtures, and parser
pin one tested API version.

Required families: Checkout completed/expired; invoice paid/payment failed; subscription created/
updated/deleted; PaymentIntent succeeded/failed/action required; refund created/updated/failed; and
dispute created/updated/closed/funds reinstated.

## Operations, privacy, and failure modes

- Stripe down: preserve reads, data, existing entitlements, and eligible balances; disable new
  checkout, plan mutations, pack purchases, and auto-recharge.
- Webhook delayed: UI remains pending; worker/reconciliation repairs; redirect never grants access.
- Ledger uncertainty/contention: bounded retry then deny provider spend.
- New mutations can be killed with a server flag while webhook ingestion and reconciliation remain.
- Raw financial payload access is platform-only, minimized, encrypted where retained, redacted from
  logs/errors, and deleted on schedule. Normalized accounting evidence follows approved retention.
- Notify credit expiry at 30/7/1 days; payment grace, action-required, dispute, refund failure, and
  reconciliation mismatch have explicit owner/operator alerts.
- Daily reconciliation compares Customers, subscriptions, invoices, payments, refunds, disputes,
  grants, and settlements. Monthly export reports gross, discounts, tax, refunds, fees, FX, net,
  outstanding invoices, and unexpired credit liability.

## Migration

Manual organization entitlements remain valid until their current end. No Stripe Customer,
subscription, saved method, or charge is created automatically. Import current manual periods,
operator trials, and promotional credits as audited `legacy_manual` records. Voluntary Checkout
activation atomically ends overlapping manual authority without duplicating access or credits.

The legacy user-owned `plans` and plan-request path becomes read-only migration history after
canonical organization cutover. The future Stripe scope in `pricing-and-billing` is superseded by
this plan. Calendar/interview removes its duplicated Stripe implementation and keeps only rate cards
and consumption integration.

## Acceptance criteria

- One organization has at most one live Customer/base subscription per livemode and no client can
  select a price, amount, tenant, role, or credit quantity.
- Duplicate, reordered, delayed, or replayed events never duplicate a charge, entitlement, grant,
  refund, or ledger effect.
- Monthly/annual Test Clocks prove creation, renewal, monthly annual grants, immediate upgrade,
  scheduled downgrade/cancel, cadence change, failed payment, seven-day grace, recovery, and expiry.
- Ledger property tests prove non-negative balance, earliest-expiry allocation, reservation survival
  across expiry, settlement/release, and compensating adjustments under concurrency.
- Tenant A cannot read/mutate tenant B billing rows; admin/member cannot cause a charge; platform
  operator endpoints are unavailable to organization roles.
- Refund, dispute, SCA recovery, Radar/velocity, auto-recharge cap, seller-country gate, migration,
  ownership transfer, deletion, and Team downgrade scenarios pass integration/E2E tests.
- Production remains disabled until KYC, tax, webhook replay, alerting, reconciliation, accounting,
  support, backup/restore, secret rotation, and rollback runbooks have evidence.

## Primary references

- [Stripe Checkout subscriptions](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Subscription changes and pending updates](https://docs.stripe.com/billing/subscriptions/change)
- [Proration](https://docs.stripe.com/billing/subscriptions/prorations)
- [Subscription cancellation](https://docs.stripe.com/billing/subscriptions/cancel)
- [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Webhook security, retries, ordering, and versioning](https://docs.stripe.com/webhooks)
- [Idempotent API requests](https://docs.stripe.com/api/idempotent_requests)
- [Customer Portal](https://docs.stripe.com/customer-management)
- [Stripe Tax Checkout](https://docs.stripe.com/tax/checkout)
- [Stripe Tax setup and registrations](https://docs.stripe.com/tax/set-up)
- [Promotion codes](https://docs.stripe.com/payments/checkout/discounts)
- [SetupIntents and off-session consent](https://docs.stripe.com/payments/setup-intents)
- [Refund events](https://docs.stripe.com/refunds)
- [Disputes](https://docs.stripe.com/disputes/how-disputes-work)
- [Billing Test Clocks](https://docs.stripe.com/billing/testing/test-clocks)
- [EU VAT OSS](https://europa.eu/youreurope/business/finance-and-tax/vat/one-stop-shop/index_en.htm)
- [Danish business and VAT registration](https://skat.dk/erhverv/moms/moms-saadan-goer-du/saadan-registrerer-du-din-virksomhed-for-moms)
