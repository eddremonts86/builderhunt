# Stripe Refund and Dispute Support Runbook

> This is the SUPPORT/OPERATOR-facing "what do I click and say" runbook. For the underlying data
> model, mismatch types, and code-level scope decisions, see the engineering-facing
> `docs/operations/stripe-disputes.md` and `src/shared/lib/billing/refunds.ts`'s own module comment.

## Handling a refund request

1. Find the request at `/admin/refunds` (`_dashboard/admin/refunds.tsx`) — it lists every pending
   `billing_refunds` row across organizations, backed by `api/admin/billing/refunds.ts`.
2. Pack-purchase refunds already have a self-service decided `policyDecision` (`full_unused_pack`) if
   the customer requested it through `requestPackRefund` and the pack's credits are still fully
   unused — nothing for an operator to decide there beyond confirming it looks right.
3. Anything else (a partial pack refund, or any subscription-invoice refund) requires an explicit
   operator decision via `decideRefund` — recorded with a `policyDecision`, exact `amountCents`, and
   for a partial pack, how many credit units to revoke (`applyCreditRevocationForRefund`).
4. Once decided, `processPendingPackRefund` is what actually calls Stripe's refund API — for pack
   refunds only; a decided subscription-invoice refund stays `pending` on the processing side today
   (see `stripe-disputes.md` for the exact scope boundary — this is a real, documented gap, not an
   oversight to silently work around).
5. The customer gets `sendRefundDecisionEmail` once processed (`notifications.ts`) — confirm they
   actually received it (dev mode logs to console only, no real email — see `email.ts`) before
   telling them to expect one.

## Handling a dispute (chargeback)

A dispute is Stripe-initiated — this app never creates one, and there is no operator "decide" action
in-app; **evidence submission and the won/lost outcome both happen in the Stripe Dashboard**, not
here (`disputes.ts`'s own module comment is explicit about this). What this app DOES do automatically
the moment a `charge.dispute.created` webhook lands: freezes the credits behind the disputed grant
(so they can't be spent while the dispute is open) and records the row in `billing_disputes`,
visible read-only at `/admin/billing/disputes` (`api/admin/billing/disputes.ts`) and to the
organization itself at `/api/billing/disputes` (owner/admin read).

1. Check `evidenceDueBy` on the dispute row (surfaced in `DisputeQueue.tsx`) — this IS the deadline
   that matters; miss it and Stripe auto-resolves against you.
2. Submit evidence in the **Stripe Dashboard → Payments → Disputes**, not in this app.
3. Once Stripe resolves it (won/lost), the corresponding webhook (`charge.dispute.closed`) unfreezes
   or permanently revokes the frozen credits automatically — no manual step needed here.
4. Pack purchase disputes only are tracked today — a subscription-invoice dispute is a documented,
   separate gap (`disputes.ts`'s own comment: never recorded for subscriptions yet).

## Escalation

- A refund/dispute question the operator can't resolve from the data above → the designated
  support/refund contact from `stripe-launch-register.md`'s "Support and operations" table
  (**currently `_not designated_`** — name a real, monitored inbox before relying on this runbook in
  production).
- Anything suggesting fraud (velocity, stolen card) → cross-reference `stripe-fraud.md`'s risk
  exception workflow before deciding a refund — a refund on a fraudulent transaction may need a risk
  exception recorded too, not just money returned.
