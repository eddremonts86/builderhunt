# Plan: Onboarding Flow

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: All phases shipped — see spec "Delivered" and the checked tasks. This
> file records the delivery order; there is no remaining implementation work besides one
> optional metrics follow-up.

## Phases (as delivered)

1. **Data model** — `onboarding_progress` table + migration.
2. **State machine lib** — `src/shared/lib/onboarding.ts` with eligibility rules and tests.
3. **API** — status/complete/skip endpoints under `src/routes/api/onboarding/`.
4. **Routes** — welcome → search → save → success under `src/routes/onboarding/`.
5. **Entry points** — signup redirect (`SignUpPage.tsx`) + dashboard banner
   (`OnboardingBanner.tsx`).

## Follow-up (optional, non-blocking)

- Activation-rate aggregation in `/api/admin/metrics` (task in tasks.md). Useful for the
  launch monitoring loop in [`waitlist-launch`](../waitlist-launch/spec.md), not required for
  the feature to function.

## Risks (historical)

None open. The one live consideration: `STARTER_QUERIES` are static strings in
`onboarding.ts` — if the search pipeline's source list changes, review that the suggestions
still return good results (cheap manual check).

## Rollback

Feature is behind eligibility rules; disabling would mean removing the signup redirect in
`SignUpPage.tsx` (one line) and the banner render in `DashboardPage.tsx`. No data risk.
