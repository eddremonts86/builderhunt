# Tasks: Onboarding Flow

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: All implementation tasks delivered and verified against `src/`
> (2026-07-19). One optional instrumentation follow-up remains at the bottom.

## Delivered

- [x] **Schema: `onboarding_progress` table** — `src/shared/lib/db/schema.ts` (PK `user_id`,
      step, completed, skipped, skipped_count, first_query_id, first_builder_ids), migrated in `drizzle/`
- [x] **State machine lib + tests** — `src/shared/lib/onboarding.ts`
      (`getOnboardingStatus`, eligibility: 7-day window, existing-data auto-skip, max 3 skips,
      `STARTER_QUERIES`), `src/shared/lib/onboarding.test.ts`
- [x] **GET /api/onboarding/status** — `src/routes/api/onboarding/status.ts`
- [x] **POST /api/onboarding/complete** — `src/routes/api/onboarding/complete.ts`
      (step 3 sets `completed=true` + `completed_at`, records builder ids)
- [x] **POST /api/onboarding/skip** — `src/routes/api/onboarding/skip.ts` (increments skip count)
- [x] **Step 1: welcome screen** — `src/routes/onboarding/welcome.tsx`
- [x] **Step 2: guided first search with 5 starter suggestions** — `src/routes/onboarding/search.tsx`
- [x] **Step 3: track 3+ builders with counter** — `src/routes/onboarding/save.tsx`
- [x] **Step 4: success screen** — `src/routes/onboarding/success.tsx`
- [x] **Signup redirect + progress-row creation** — `src/modules/auth/components/SignUpPage.tsx:39-48`
      (redirects to `/onboarding/welcome`)
- [x] **Dashboard banner for eligible users** — `src/modules/dashboard/components/OnboardingBanner.tsx`
      (localStorage dismiss, rendered in `DashboardPage.tsx:194`)
- [x] **Crawler hygiene** — `/onboarding/` disallowed in `src/routes/robots[.]txt.ts`

## Optional follow-up (non-blocking)

- [ ] **Add activation metrics to the admin metrics endpoint**
  - Files: `src/routes/api/admin/metrics/index.ts`
  - Do: Add to the response: `onboardingCompleted` (count of `onboarding_progress` where
    `completed=true`), `onboardingSkipped` (skipped=true), and `activationRate7d`
    (completed among users created in the last 7 days / signups in the last 7 days). The
    endpoint already queries `authUsers` with `gte(createdAt, oneDayAgo)` — follow the same
    drizzle `count()` pattern.
  - Verify: `curl` the endpoint as an admin — new fields present and consistent with a manual
    SQL count; non-admin still gets 403.
