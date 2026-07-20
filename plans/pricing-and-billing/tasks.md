# Tasks: Pricing & Billing

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`team-accounts`](../team-accounts/spec.md), [`ai-expansion`](../ai-expansion/spec.md), [`semantic-search`](../semantic-search/spec.md), [`code-fingerprinting`](../code-fingerprinting/spec.md), [`work-sample`](../work-sample/spec.md)
> **Reality check**: Billing v1 delivered (see checked tasks). Remaining: 3 correctness fixes
> in Phase 1; Stripe is a deferred phase with an explicit trigger.

## Phase 0 — Delivered (audited against src, 2026-07-19)

- [x] **Schema: `plans`, `plan_changes`, `plan_requests` tables** — `src/shared/lib/db/schema.ts`, migrated in `drizzle/`
- [x] **`PLAN_LIMITS` / `PLAN_PRICING` constants (client-safe)** — `src/shared/lib/billing-shared.ts`
- [x] **Server billing helpers with tests** — `src/shared/lib/billing.ts` (`getUserPlan`, `setUserPlan`, `requestPlanUpgrade`, `resolvePlanRequest`, `checkLimit`, `listAllUsersWithPlans`, `listPlanRequestsWithUsers`), `src/shared/lib/billing.test.ts` (12 tests)
- [x] **savedSearches limit enforced on saved-query creation** — `src/routes/api/queries/index.ts:57`
- [x] **savedBuilders limit enforced on track** — `src/routes/api/builders/track.ts:60` (counts tracked builders)
- [x] **Smart alerts gated to paid plans** — `src/routes/api/alerts/index.ts:71`
- [x] **/pricing page (tiers, toggle, FAQ, request-upgrade)** — `src/routes/_landing/pricing.tsx`
- [x] **/settings/billing (plan card, usage meters, change history)** — `src/routes/_dashboard/settings/billing.tsx`, `src/routes/api/plans/me.ts`, `src/routes/api/me/plan-changes/index.ts`
- [x] **Upgrade request endpoint** — `src/routes/api/plans/request-upgrade.ts`
- [x] **Admin: users list + set plan** — `src/routes/_dashboard/admin/users.tsx`, `src/routes/api/admin/users/index.ts`, `src/routes/api/admin/users/$userId.ts`
- [x] **Admin: plan-requests queue with approve/decline (approval sets plan + 30d planEndsAt)** — `src/routes/_dashboard/admin/plan-requests.tsx`, `src/routes/api/admin/plan-requests/index.ts`

## Phase 1 — Correctness fixes

- [ ] **Align /pricing with the actual PLAN_PRICING contract**
  - Files: `src/routes/_landing/pricing.tsx`
  - Do: Line 143 reads `config.priceMonthly` / `config.priceAnnual`; `PLAN_PRICING` entries
    have `monthly` / `annual` (`src/shared/lib/billing-shared.ts:13`). Change to
    `config.monthly` / `config.annual`. Replace the hardcoded rows that read nonexistent
    `maxSavedSearches`, `maxSavedBuilders`, `maxRssFeeds`, `hasAlerts`, `hasCodeStyle`, and
    `maxTeamSeats` from `config` with `config.features.map(...)`; every declared feature gets
    a Check icon and no unavailable state is inferred from absent fields. Keep the `/yr` label
    for annual because 182 and 950 are yearly totals.
  - Verify: `pnpm type-check` passes; visit `/pricing`, toggle Monthly/Annual — cards show
    $0/$19/$99 then $0/$182/$950, render every `PLAN_PRICING[tier].features` string exactly
    once, and never show `$undefined`.

- [ ] **Enforce plan expiry in `getUserPlan`**
  - Files: `src/shared/lib/billing.ts`, `src/shared/lib/billing.test.ts`
  - Do: In `getUserPlan`, if the row's `plan !== 'free'` and `planEndsAt` is set and in the
    past, update the row to `{ plan: 'free', status: 'canceled', planEndsAt: null }`, insert a
    `plan_changes` row (`fromPlan: <old>`, `toPlan: 'free'`, `changedBy: 'system:expiry'`,
    `reason: 'plan expired'`), and return the free plan. Add tests: expired pro → free with
    audit row; future `planEndsAt` → unchanged; `planEndsAt` null → unchanged.
  - Verify: `pnpm test billing` — new tests pass; existing 12 still pass.

- [ ] **Remove the dead `rssSubscriptions` limit**
  - Files: `src/shared/lib/billing-shared.ts`, `src/shared/lib/billing.ts`,
    `src/shared/lib/billing.test.ts`, `src/routes/api/plans/me.ts`,
    `src/routes/_dashboard/settings/billing.tsx`
  - Do: Nothing enforces it (`src/routes/api/feeds/$searchId.ts` has no plan check), and RSS
    feeds are 1:1 with saved searches which are already limited. Delete `rssSubscriptions`
    from `PLAN_LIMITS`, the `LimitResource` union, the `checkLimit` branch, the `/api/plans/me`
    response, and the usage meter in settings. Update the free-tier feature copy in
    `PLAN_PRICING.free.features` from "Basic RSS feeds" to "RSS feeds for saved searches".
  - Verify: `pnpm type-check` and `pnpm test billing` pass; `/settings/billing` shows two
    usage meters (searches, builders) with no blank third row.

## Phase 2 — Cross-plan gating (owned elsewhere, tracked here for visibility)

- [ ] **Confirm each promised paid feature ships with its gate** (no code in this plan)
  - Files: none here — gates land in `semantic-search`, `code-fingerprinting`, `work-sample`,
    `team-accounts`, `ai-expansion` per the spec's gating map.
  - Do: When reviewing those plans' PRs, check the gate exists and uses
    `getEffectivePlan(userId)` once `team-accounts` has shipped it.
  - Verify: For each shipped feature, a free-plan request to its endpoint returns 402/403 with
    an upgrade message.

## Future trigger — Stripe (not part of this plan)

At ≥50 paying customers or ≥$1k MRR, create a dedicated Stripe spec/plan/tasks trio after
verifying the then-current API and tax/compliance requirements. Until that trigger, the manual
admin-approved system is the complete scoped product and no Stripe checkbox is executable here.
