# Tasks: Onboarding Flow

## Phase 0 — Research

- [ ] Read `src/modules/auth/components/SignUpPage.tsx` to see current signup flow
- [ ] Read `src/modules/auth/components/SignInPage.tsx` for current signin redirect
- [ ] Check what URL signup currently redirects to (likely /dashboard)

## Phase 1 — Data model

- [ ] Add `onboarding_progress` table to schema
- [ ] Generate + apply migration
- [ ] Add helper: `getOnboardingStatus(userId)` in `src/shared/lib/onboarding.ts`

## Phase 2 — Onboarding routes

File: `src/routes/onboarding/welcome.tsx` (Step 1)

- [ ] Welcome screen with value prop
- [ ] "Show me how" → /onboarding/search
- [ ] "Skip" → POST /api/onboarding/skip, redirect /dashboard
- [ ] Track step completion on mount

File: `src/routes/onboarding/search.tsx` (Step 2)

- [ ] 5 starter suggestions as buttons
- [ ] Each button auto-navigates to /search?q=X
- [ ] Free input + Search button for custom query
- [ ] "Skip" option

File: `src/routes/onboarding/save.tsx` (Step 3)

- [ ] Renders search results from `?q=...` URL param
- [ ] Counter: "Saved 0/3 builders"
- [ ] "Save" buttons on each card
- [ ] After 3+ saves, "Continue" button enabled
- [ ] On Continue → POST /api/onboarding/complete with builder ids, redirect to success

File: `src/routes/onboarding/success.tsx` (Step 4)

- [ ] "🎉 Your radar is live!"
- [ ] "Go to dashboard" + "See today's picks" CTAs
- [ ] Marks onboarding completed

## Phase 3 — API endpoints

File: `src/routes/api/onboarding/status.ts` (GET)

- [ ] Returns `{ step, completed, skipped, firstQueryId, savedBuilderIds }`

File: `src/routes/api/onboarding/skip.ts` (POST)

- [ ] Auth required
- [ ] Marks skipped=true
- [ ] Returns 200

File: `src/routes/api/onboarding/complete.ts` (POST)

- [ ] Auth required
- [ ] Body: `{ step: int, firstQueryId?: string, builderIds?: string[] }`
- [ ] Updates row
- [ ] If step=3, marks completed=true, completed_at=now

## Phase 4 — Signup redirect

File: `src/modules/auth/components/SignUpPage.tsx`

- [ ] After signup success, redirect to /onboarding/welcome (not /dashboard)
- [ ] Create initial `onboarding_progress` row with step=0 (server-side, in signup handler)

## Phase 5 — Dashboard banner

File: `src/modules/dashboard/components/OnboardingBanner.tsx` (new)

- [ ] Fetches /api/onboarding/status on mount
- [ ] Shows dismissable banner if step=0 and not skipped
- [ ] "Start 3-step tour" button → /onboarding/welcome

## Phase 6 — Suggestions table

- [ ] Static list of 5 starter queries in code (no need for DB):
  - "rust async runtime"
  - "indie hackers in EU"
  - "AI agents in production"
  - "react performance"
  - "python ML engineers"

## Phase 7 — Verification

### Manual
- [ ] Sign up new user → land on /onboarding/welcome
- [ ] Click "Show me how" → /onboarding/search
- [ ] Click a suggestion → land on /search?q=...
- [ ] Click "Save" on 3 builders → "Continue" enables
- [ ] Click "Continue" → success screen
- [ ] Click "Go to dashboard" → see saved builders + saved search
- [ ] Sign in as existing user (no onboarding) → dashboard normal, no banner

### Automated (Playwright)
- [ ] New user signup redirects to /onboarding/welcome
- [ ] Skip flow works (banner disappears)
- [ ] Completion flow: 3 saves → success → dashboard

### Performance
- [ ] Each onboarding page < 200ms TTFB
- [ ] No layout shift between steps

## Phase 8 — Rollout

- [ ] Start with 100% of new signups
- [ ] Monitor activation rate
- [ ] If < 50% activation after 2 weeks, simplify

## Edge cases

- **User signs up but doesn't complete onboarding**: banner shows on dashboard for 7 days, then hides
- **User creates saved search outside onboarding flow**: auto-complete onboarding step 2
- **User refreshes mid-onboarding**: each step is a separate route, so refresh is OK
- **Mobile**: ensure layouts work on small screens
- **Skip clicked 3+ times**: don't show banner again
- **User is testing in dev**: they want to skip. Show "Dev: skip onboarding" link.

## Dependencies

- Existing: `authUsers`, `savedQueries`, `builders`
- New table: `onboarding_progress`
- New files: 4 routes, 3 API endpoints, 1 banner component
- No new packages

## Estimated effort: 2 days
