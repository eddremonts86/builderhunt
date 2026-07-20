# Plan: Pricing & Billing

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`team-accounts`](../team-accounts/spec.md), [`ai-expansion`](../ai-expansion/spec.md), [`semantic-search`](../semantic-search/spec.md), [`code-fingerprinting`](../code-fingerprinting/spec.md), [`work-sample`](../work-sample/spec.md)
> **Reality check**: Manual billing v1 is live (`src/shared/lib/billing.ts`, `billing-shared.ts`,
> `plans`/`plan_changes`/`plan_requests` tables, `/pricing`, `/settings/billing`, admin UIs).
> Remaining work is corrective (price display bug, expiry enforcement, dead limit) plus a
> deferred Stripe phase.

## Phases

### Phase 0 — Delivered (2026-07)

Tables, helpers + tests, limit enforcement (savedSearches, savedBuilders, alerts gate),
`/pricing`, `/settings/billing`, admin users + plan-requests, request-upgrade flow.
See spec "Delivered" for file-by-file detail. No re-work needed.

### Phase 1 — Correctness fixes (launch-blocking, ~half a day)

1. Fix the `/pricing` price-field mismatch (`priceMonthly`→`monthly`, `priceAnnual`→`annual`).
2. Enforce `planEndsAt` in `getUserPlan`: expired paid plan is treated as `free` and the row is
   downgraded (with a `plan_changes` audit entry, `changedBy: 'system:expiry'`).
3. Remove the unenforced `rssSubscriptions` limit from `PLAN_LIMITS`, `LimitResource`,
   `checkLimit`, `/api/plans/me`, and the `/settings/billing` usage list.

### Phase 2 — Cross-plan gating hooks (as sibling plans land)

No code in this plan. Each feature plan adds its own gate (see spec table). When
`team-accounts` ships `getEffectivePlan`, review all `getUserPlan` gating call sites
(`src/routes/api/alerts/index.ts`, `api/queries/index.ts`, `api/builders/track.ts`) and switch
them — that switch is a task in `team-accounts`, tracked there.

### Phase 3 — Stripe (DEFERRED — trigger: ≥50 paying customers or ≥$1k MRR)

Add `stripe` SDK, `stripe_customer_id`/`stripe_subscription_id` columns, Checkout session
endpoint, webhook that calls `setUserPlan`, Customer Portal link on `/settings/billing`.
Do not start before the trigger; do not build partial pieces "to be ready".

## Risks

| Risk                                                         | Likelihood | Mitigation                                                                                                |
| ------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------- |
| Expiry downgrade surprises a user who paid late              | Medium     | Admin approval sets `planEndsAt`; admins can extend via `/admin/users`; audit entry names `system:expiry` |
| Removing `rssSubscriptions` breaks `/api/plans/me` consumers | Low        | Only consumers are `/settings/billing` and tests — both updated in the same task                          |
| Feature plans ship without their billing gate                | Medium     | Conventions rule 7; each owning plan's tasks include the gate; this plan's spec table is the checklist    |

## Rollback

All Phase 1 changes are additive or subtractive in pure modules with tests; revert the commit.
The expiry downgrade writes audit rows, so any wrongly-downgraded user is recoverable from
`plan_changes` (admin re-grants via `/admin/users`).
