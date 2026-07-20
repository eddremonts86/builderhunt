# Pricing & Billing (Manual, Admin-Approved — No Payment Processor)

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`team-accounts`](../team-accounts/spec.md), [`ai-expansion`](../ai-expansion/spec.md), [`semantic-search`](../semantic-search/spec.md), [`code-fingerprinting`](../code-fingerprinting/spec.md), [`work-sample`](../work-sample/spec.md)
> **Reality check**: Billing v1 is live: `plans`/`plan_changes`/`plan_requests` tables
> (`src/shared/lib/db/schema.ts`), `PLAN_LIMITS`/`PLAN_PRICING` (`src/shared/lib/billing-shared.ts`),
> server helpers + limit enforcement (`src/shared/lib/billing.ts` + `billing.test.ts`), `/pricing`
> page, `/settings/billing`, admin plan-requests UI, `/api/plans/request-upgrade`. **No payment
> processor exists** and none is planned for launch.

## Problem

BuilderHunt needs a way to monetize (free/pro/team tiers) without spending days integrating
a payment processor at 0 paying customers. The manual-approval model is built; what remains
is fixing display bugs, closing enforcement holes, and defining the Stripe trigger point.

## Goal

A correct, fully-enforced manual billing system: accurate prices on `/pricing`, every limit in
`PLAN_LIMITS` actually enforced (or removed), plan expiry honored, and a documented path to
Stripe that we deliberately do NOT take until volume justifies it.

## Non-goals

- **No Stripe/Paddle/Lemonsqueezy at launch.** Decision (2026-07-19): manual admin approval is
  the right model for a pre-revenue product. Stripe is a defined future phase with an explicit
  trigger (see "Stripe trigger" below), not launch work.
- No coupons, tax compliance, refund automation, invoicing.
- No team seats or shared billing — that is [`team-accounts`](../team-accounts/spec.md), which
  owns `PLAN_LIMITS.seats` and the `getEffectivePlan(userId)` helper.

## Delivered (audited 2026-07-19)

- **Tiers & pricing**: free $0 / pro $19/mo ($182/yr) / team $99/mo ($950/yr) in
  `PLAN_PRICING` (`src/shared/lib/billing-shared.ts`), with per-tier feature lists.
- **Data model**: `plans` (PK `user_id`, 1:1), `plan_changes` (audit log), `plan_requests`
  (upgrade queue) — all in `src/shared/lib/db/schema.ts`, migrated.
- **Server helpers** (`src/shared/lib/billing.ts`, 12 tests in `billing.test.ts`):
  `getUserPlan` (auto-creates free row), `setUserPlan` (writes `plan_changes`),
  `requestPlanUpgrade` (dedupes pending), `resolvePlanRequest`, `checkLimit`,
  `listAllUsersWithPlans`, `listPlanRequestsWithUsers`.
- **Limit enforcement**: `savedSearches` in `src/routes/api/queries/index.ts`;
  `savedBuilders` in `src/routes/api/builders/track.ts` (counts tracked builders);
  smart alerts gated to paid plans in `src/routes/api/alerts/index.ts`.
- **User-facing**: `/pricing` (`src/routes/_landing/pricing.tsx`) with monthly/annual toggle,
  FAQ, request-upgrade flow; `/settings/billing` (`src/routes/_dashboard/settings/billing.tsx`)
  with plan card, usage meters, plan-change history via `/api/me/plan-changes`;
  `/api/plans/me`, `/api/plans/request-upgrade`.
- **Admin**: `/admin/users` (set plan via `/api/admin/users/$userId` → `setUserPlan`),
  `/admin/plan-requests` (approve/decline via `/api/admin/plan-requests`, approval sets the
  plan with a 30-day `planEndsAt`).

## Remaining work (each gap cited)

1. **Pricing renderer uses the wrong contract**: `src/routes/_landing/pricing.tsx:143` reads
   `config.priceMonthly` / `config.priceAnnual`, but `PLAN_PRICING` entries expose
   `monthly` / `annual` (`src/shared/lib/billing-shared.ts:13`). The same component also reads
   nonexistent `maxSavedSearches`, `maxSavedBuilders`, `maxRssFeeds`, `hasAlerts`,
   `hasCodeStyle`, and `maxTeamSeats` instead of the declared `features[]`. It does not
   type-check and can render `$undefined`/incorrect feature rows.
2. **Plan expiry is never enforced**: `setUserPlan` stores `planEndsAt` (admin approval sets
   now+30d in `src/routes/api/admin/plan-requests/index.ts:72`), but `getUserPlan`
   (`src/shared/lib/billing.ts:17-39`) returns the stored plan regardless of expiry. A lapsed
   Pro user keeps Pro forever unless an admin remembers to downgrade.
3. **`rssSubscriptions` limit is dead config**: defined in `PLAN_LIMITS` and displayed in
   `/settings/billing`, but no route checks it — `src/routes/api/feeds/$searchId.ts` serves
   any saved search's feed. RSS feeds are 1:1 with saved searches (already limited), so the
   separate limit is redundant and should be removed.
4. **Gates for promised-but-unbuilt features**: `PLAN_PRICING.pro.features` promises
   "Semantic search" and "Code fingerprinting"; `.team.features` promises "Work-sample
   analysis", "Team seats", "Shared lists", "Activity feed". Those gates belong to the plans
   that build the features (see cross-plan map below) — this plan only requires that each of
   them lands its billing gate before its feature ships.

## Cross-plan gating map (shared surface: `PLAN_LIMITS`/`PLAN_PRICING` in billing-shared.ts)

| Promised feature                          | Owning plan                                                                                                                                 | Gate location it must add                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Smart alerts (pro)                        | delivered                                                                                                                                   | `src/routes/api/alerts/index.ts` (done)                                                                            |
| Semantic search (pro)                     | [`semantic-search`](../semantic-search/spec.md)                                                                                             | its search endpoint, via AI task tier policy                                                                       |
| Code fingerprinting v2 (pro)              | [`code-fingerprinting`](../code-fingerprinting/spec.md)                                                                                     | its enrich endpoint                                                                                                |
| Work-sample analysis (team)               | [`work-sample`](../work-sample/spec.md)                                                                                                     | its analysis endpoint                                                                                              |
| Team seats / shared lists / activity feed | [`team-accounts`](../team-accounts/spec.md), [`shared-resources`](../shared-resources/spec.md), [`activity-feed`](../activity-feed/spec.md) | `team-accounts` adds `PLAN_LIMITS.seats` (`free:1, pro:1, team:10`) and `getEffectivePlan(userId)` in `billing.ts` |
| AI usage allowances per tier              | [`ai-expansion`](../ai-expansion/spec.md)                                                                                                   | per-task rate limits in the AI task registry                                                                       |

**Rule**: once `team-accounts` ships `getEffectivePlan(userId)`, all new gating code must call
it instead of `getUserPlan` so team members inherit the owner's plan. Do not duplicate that
helper here.

## Stripe trigger (deferred phase)

Integrate Stripe only when ≥50 paying customers OR ≥$1k MRR (whichever first). The `plans`
table is already Stripe-shaped: `status` ↔ `subscription.status`, `planEndsAt` ↔
`current_period_end`. Migration adds `stripe_customer_id`/`stripe_subscription_id` columns and
a webhook that calls the existing `setUserPlan`. Admin UI and limit enforcement are unchanged.
Nothing in the codebase may assume Stripe webhooks exist before then.

## Success metrics

- Free → Pro conversions per month (rows in `plan_changes` with `to_plan='pro'`).
- Pending `plan_requests` per week (intent-to-pay signal).
- Expired plans auto-downgraded within 24h of `planEndsAt` (after task 2 lands).

## Resolved questions

- Manual billing at launch: **yes** — the request→admin-approve loop already works end to end.
- Annual pricing: totals per year ($182 = 19×12×0.8, $950 = 99×12×0.8), shown with "-20%".
