# Delivery Record: Pricing and Billing V1

> **Status**: `superseded`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: legacy manual billing is partially present in source. Its corrective and Stripe
> future work moved to [`stripe-billing-platform`](../../implemented/phase-1/30-stripe-billing-platform/plan.md); this file is
> historical and has no executable phase.

## Delivered

1. Per-user manual plan, change history, and request tables.
2. Manual plan helpers, platform user/request administration, and initial plan gates.
3. Pricing and billing settings surfaces later partially adapted to organization entitlements.

## Superseded scope

- Pricing correctness, Pro Max, Team $199/$1,910, and all organization entitlement reconciliation.
- Plan expiry/dunning and migration away from user-owned authority.
- Stripe Products/Prices, Checkout, Portal, webhooks, tax, credits, refunds, disputes, and accounting.

These now execute only through [`stripe-billing-platform`](../../implemented/phase-1/30-stripe-billing-platform/plan.md), which
contains dependency gates, phased rollout, risks, rollback, and completion evidence.

## Rollback/history rule

Do not delete legacy rows or disable manual authority before the replacement plan's migration and
mixed-state tests pass. Historical reads remain available for audit; new paid mutations move to the
organization billing control plane.
