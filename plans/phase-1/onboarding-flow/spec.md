# Onboarding Flow

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Fully built: `onboarding_progress` table (`src/shared/lib/db/schema.ts`),
> state machine `src/shared/lib/onboarding.ts` (+ tests), API endpoints
> `src/routes/api/onboarding/{status,complete,skip}.ts`, routes
> `src/routes/onboarding/{welcome,search,save,success}.tsx`, signup redirect in
> `src/modules/auth/components/SignUpPage.tsx`, dashboard banner
> `src/modules/dashboard/components/OnboardingBanner.tsx`.

## Problem (solved)

New signups landed on an empty dashboard with no guidance — no first search, no "aha moment",
low activation.

## Goal (achieved)

A skippable 3-step onboarding that ends with the user's first tracked builders:
welcome → guided first search (5 starter suggestions) → track 3+ builders → success screen.

## Delivered (audited 2026-07-19)

- **Data model**: `onboarding_progress` (PK `user_id`, `step 0..3`, `completed`, `skipped`,
  `skipped_count`, `first_query_id`, `first_builder_ids` jsonb) in `src/shared/lib/db/schema.ts`.
- **State machine** (`src/shared/lib/onboarding.ts`, tests in `onboarding.test.ts`):
  `getOnboardingStatus`, eligibility rules (7-day signup window `ONBOARDING_WINDOW_DAYS`,
  auto-ineligible when the user already has saved searches/builders, `MAX_SKIPS = 3`),
  `STARTER_QUERIES` (5 static suggestions), `TOTAL_STEPS = 3`. Server-only via dynamic DB
  imports so the client bundle stays clean.
- **API**: `GET /api/onboarding/status`, `POST /api/onboarding/complete` (step, firstQueryId,
  builderIds; step 3 sets `completed` + `completed_at`), `POST /api/onboarding/skip`.
- **Routes**: `/onboarding/welcome` (value prop, Show-me-how / Skip),
  `/onboarding/search` (starter suggestion buttons + free input),
  `/onboarding/save` (results with track buttons, 0/3 counter, continue),
  `/onboarding/success` (CTAs to dashboard / picks).
- **Entry points**: signup redirects to `/onboarding/welcome` and creates the progress row
  (`src/modules/auth/components/SignUpPage.tsx:39-48`); dismissable dashboard banner for
  eligible users (`OnboardingBanner.tsx`, localStorage dismiss key, rendered in
  `DashboardPage.tsx:194`).
- **Edge cases handled**: refresh-safe (each step is a route), skip-count cap, existing users
  auto-ineligible, `robots.txt` disallows `/onboarding/`.

## Non-goals (unchanged)

Persona-specific onboarding, video tours, A/B framework, re-onboarding for returning users.

## Success metrics

- Primary: activation rate (signup → completed onboarding or first tracked builder) > 60%.
- Secondary: skip rate < 30%.
- Measurement note: raw data exists (`onboarding_progress`, `builders`), but
  `/api/admin/metrics` (`src/routes/api/admin/metrics/index.ts`) does not yet aggregate an
  activation rate — see the single optional follow-up task in tasks.md. Non-blocking.
