# Tasks: Onboarding Flow

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: All implementation tasks delivered and verified against `src/`
> (2026-07-19). The optional instrumentation follow-up (activation metrics) delivered
> 2026-07-25.

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

- [x] **Add activation metrics to the admin metrics endpoint**
  - Files: `src/routes/api/admin/metrics/index.ts`
  - Do: Add to the response: `onboardingCompleted` (count of `onboarding_progress` where
    `completed=true`), `onboardingSkipped` (skipped=true), and `activationRate7d`
    (completed among users created in the last 7 days / signups in the last 7 days). The
    endpoint already queries `authUsers` with `gte(createdAt, oneDayAgo)` — follow the same
    drizzle `count()` pattern.
  - Verify: `curl` the endpoint as an admin — new fields present and consistent with a manual
    SQL count; non-admin still gets 403.
  - **Done — required a new migration.** `onboarding_progress`'s RLS (0008_tenant_rls.sql) only
    ever had a `builderhunt_app` policy, scoped per-organization by `app.organization_id` — the
    platform role had no policy at all on this table, and RLS is FORCE'd, so a platform-role read
    would have returned zero rows regardless of any grant. Added
    `0049_onboarding_progress_platform_read.sql`: `GRANT SELECT` + a `USING (true)` unscoped
    SELECT policy for `builderhunt_platform` — read-only aggregate admin reporting, same
    "platform reads across all tenants for metrics" precedent as `account_risk`'s/
    `abuse_signals`' platform-scoped reads earlier this session. New
    `getOnboardingActivationMetrics(oneWeekAgo)` in `repositories/platform-billing.ts` (same
    `count()`/`Promise.all` pattern as the existing `getPlatformAccountMetrics`), joining
    `onboarding_progress` to `auth_users` for the 7-day completed count. `activationRate7d` is
    `null` (not `NaN`/`Infinity`) when there were zero new users in the window, avoiding a
    divide-by-zero.
    - Applied the migration to the local dev DB and confirmed via `psql`'s
      `information_schema.role_table_grants`/`pg_policies` that the grant and policy landed
      exactly as intended. Regenerated `drizzle/migration-hashes.json` via
      `node scripts/db/verify-migration-integrity.mjs --write`.
    - **Live-verified against the real endpoint** as the seeded platform admin: `GET
      /api/admin/metrics` returned `onboardingCompleted: 1, onboardingSkipped: 1,
      activationRate7d: 0`, cross-checked against a manual `psql` count
      (`count(*) filter (where completed)`/`filter (where skipped)` = 1/1; a join count for
      completions among last-7-day signups = 0) — exact match. Confirmed an unauthenticated
      request gets 401 (no session at all — the task's own "403" wording describes an
      authenticated non-admin, which the pre-existing third test in this route's test file
      already covers).
    - Found and fixed a real test gap while verifying: the existing
      `admin/metrics/index.test.ts` mocked `getPlatformAccountMetrics` but had no mock for the
      new `getOnboardingActivationMetrics`, so `pnpm vitest run` failed with a real (test-env)
      DB connection error rather than using the mock. Added the mock plus two new tests: the
      7-day rate computes correctly from mocked inputs, and it's `null` (not a divide-by-zero
      artifact) when there were no new users in the window.
    - Verify sweep: `pnpm tsc --noEmit`, `pnpm eslint` (clean), full `pnpm vitest run`
      (2006/2006 passing), `pnpm security:route-coverage` (106 routes, valid).
