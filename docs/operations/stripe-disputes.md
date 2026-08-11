# Stripe Billing Dispute Freeze, Outcome, and Alerts

## Scope: pack disputes only

`src/shared/lib/billing/disputes.ts` handles chargebacks (Stripe "disputes") against **manually-
purchased or auto-recharge-triggered pack credit grants only**. Subscription disputes are a
deliberate, documented gap — the same one `refunds.ts` (§8 task 4) already has for subscription
refunds: resolving "which organization/subscription" from a bare disputed PaymentIntent requires
knowing that PaymentIntent belongs to a specific subscription invoice, and this codebase never
records an invoice's PaymentIntent id anywhere. Only `billing_credit_grants.stripe_payment_intent_id`
is populated (for packs and auto-recharge grants — see §8 task 4's evidence in
`plans/implemented/phase-1/30-stripe-billing-platform/tasks.md`). A disputed subscription-invoice PaymentIntent simply
cannot be resolved to an organization today, so its webhook events stay `'deferred'` — visible and
retried forever, never silently dropped, never misattributed.

## What happens on each event

| Stripe event | Handler | Effect |
| --- | --- | --- |
| `charge.dispute.created` | `handleDisputeCreated` | Resolves the organization from the disputed PaymentIntent (via `findOrganizationIdForDisputedPaymentIntent`, matching only pack/auto-recharge grants). Records the dispute row and, if it has an `active` linked grant, **freezes** it (`credits.ts`'s `freezeCreditGrant`). |
| `charge.dispute.updated` | `handleDisputeUpdated` | Status/evidence-deadline sync only (e.g. `needs_response` → `warning_under_review`). Never changes `outcome` or touches the grant. |
| `charge.dispute.closed` | `handleDisputeClosed` | The only event that sets a terminal `outcome`. `won` **unfreezes** the linked grant back to `active`; anything else (`lost`, or the ambiguous `warning_closed`) **revokes** it permanently — never silently restoring access on an ambiguous closure. |
| `charge.dispute.funds_reinstated` | `handleDisputeFundsReinstated` | Records `funds_reinstated_at` as an accounting fact only. Does **not** reverse a `lost` dispute's credit revocation — `revokeCreditGrant` is a one-way terminal transition by design, matching every other terminal ledger transition in this codebase (no "un-revoke" primitive exists anywhere). Reinstated funds are a downstream financial-reconciliation fact for §10 (not yet built) to consume. |

Every handler is idempotent against duplicate webhook deliveries: `createDisputeIfAbsent` is keyed
on `(organization_id, stripe_dispute_id)`, and `resolveDispute` is a no-op once `outcome` has already
left `'open'` — a duplicate `charge.dispute.closed` delivery can never flip an already-resolved
outcome, even if it reports a different result.

## Alerting

No notification channel exists yet in this codebase (§10, not yet built). `evidence_due_by` is
stored on every dispute row and surfaced prominently in the admin `DisputeQueue` view
(`/admin/disputes`) — a real, honest implementation of "alert" given today's infrastructure, not a
stub promising something that doesn't exist.

## Reviewing disputes

Platform operators can list an organization's disputes through `/api/admin/billing/disputes`
(platform-admin authenticated, read-only — there is deliberately **no** operator "decide" mutation
here, unlike refunds; evidence submission and the won/lost outcome both live entirely in the Stripe
Dashboard):

```sh
curl -X GET '/api/admin/billing/disputes?organizationId=org_123' \
  -H 'Cookie: <admin session>'
```

The dashboard equivalent is `/admin/disputes` (linked from the user menu's admin section).

## Data model

`billing_disputes` — tenant-private, worker-write-only (`app`: SELECT only, `worker`: SELECT/INSERT/
UPDATE, `platform`: SELECT only — see `drizzle/0036_billing_disputes_rls_grants.sql`). One row per
Stripe dispute: `stripe_dispute_id`, `stripe_payment_intent_id`, `amount_cents`, `reason`,
`stripe_status` (Stripe's own status string, synced verbatim), `outcome` (`open` | `won` | `lost`,
this app's own terminal field), `evidence_due_by`, `funds_reinstated_at`. `grant_id` is nullable and
references `billing_credit_grants` — null when the disputed PaymentIntent matches no pack/
auto-recharge grant this app tracks (the subscription-dispute gap described above).
