# Pricing and Billing V1 — Superseded Record

> **Status**: `superseded`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: this plan delivered the legacy per-user manual billing path in
> `src/shared/lib/repositories/platform-billing.ts`, `src/shared/lib/billing-shared.ts`, the
> `plans`/`plan_changes`/`plan_requests` tables, `/pricing`, `/settings/billing`, and the platform
> plan-request UI. Organization entitlements now exist and the approved replacement is
> [`stripe-billing-platform`](../../implemented/phase-1/30-stripe-billing-platform/spec.md).

## Supersession decision

This plan's original goal was a temporary manual, admin-approved billing system with no payment
processor. That history remains useful, but its deferred “thin Stripe webhook calls `setUserPlan`”
design is unsafe for organization subscriptions, annual monthly credits, proration, refunds,
disputes, tax, and synchronous provider-cost authorization.

All future billing implementation is owned by
[`stripe-billing-platform`](../../implemented/phase-1/30-stripe-billing-platform/spec.md). It migrates the delivered artifacts
rather than rebuilding or silently deleting them. No unchecked task remains executable here.

## Delivered inventory

- Legacy `plans`, `plan_changes`, and `plan_requests` schema and manual platform repositories.
- Original Free/Pro/Team `PLAN_LIMITS` and `PLAN_PRICING` constants.
- Manual upgrade request, platform approval, user history, pricing, and billing settings surfaces.
- Initial saved-search/saved-builder/alert plan gates.
- Organization entitlement schema and current `/api/plans/me` projection arrived later through the
  security/multitenancy foundation.

## Replacement contract

- The replacement owns Pro Max, updated Team pricing, Stripe catalog/Checkout/Portal, organization
  subscription state, credit ledger, dunning, tax, refunds, disputes, reconciliation, and migration.
- Manual periods/trials/promos import as audited `legacy_manual`; no automatic Customer,
  subscription, saved payment method, or charge is allowed.
- Legacy user-plan mutations become read-only history only after canonical organization cutover and
  verified voluntary migration.
- Feature limits and gates remain organization-owned and are reconciled in the replacement tasks.

## Archived discovery

The original Spanish payment-flow analysis is preserved outside the executable plan directory at
[`docs/archive/pricing-and-billing-process-analysis.txt`](../../../docs/archive/pricing-and-billing-process-analysis.txt).
