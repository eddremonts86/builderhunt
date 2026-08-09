# Personalized invitations — Delivery Plan

> **Status**: `pending`

## Delivery principles

1. **Schema first, then UI.** The `invitee_segment` column must exist before any UI
   reads it. The migration is additive; existing rows get `NULL` and the new flow
   falls back to the `other` segment copy.
2. **The recruiter sees what the invitee sees.** The recruiter-side modal renders
   the same four-section card the invitee will see. No surprises.
3. **Real data, no mock data.** The three example results on the accept page come
   from the existing `/api/search` endpoint. The keyword is the recruiter's
   most-used search, or a sensible default per segment.
4. **The accept transaction is unchanged.** `acceptInvitationRecord` runs as it
   does today. The new flow refines the surrounding UI only.

## Dependency map

```
A ["Phase 0: schema migration"] --> B ["Phase 1: invite composer (recruiter-side)"]
B --> C ["Phase 2: personalized accept page (invitee-side)"]
C --> D ["Phase 3: post-accept handoff to /onboarding"]
D --> E ["Phase 4: beta-mode coherence + verification"]
```

## Phase 0 — Schema migration

### Outcome

`organization_invitations` has three new columns: `invitee_segment` (text, check
constraint on the four-segment taxonomy), `invitee_role_title` (text, nullable),
`invitee_company` (text, nullable). All three are nullable; existing rows keep
working.

### Work

- Author `drizzle/0143_organization_invitations_personalization.sql`. ALTER TABLE adds
  the three columns. The check constraint on `invitee_segment` matches the
  `phase-2/02-segmentacion-usuarios` taxonomy exactly.
- Update `src/shared/lib/db/schema.ts` to export the new columns. Re-export the
  segment enum (`'hiring' | 'investing' | 'building' | 'other'`) as a Drizzle enum
  so callers can reference it.
- Add a single typed helper in
  `src/shared/lib/organizations/contracts.ts`: `type InviteeSegment =
  'hiring' | 'investing' | 'building' | 'other'`. The segment list is the source of
  truth across the four-segment consumers (this plan, the future
  `06-landing-segmentada`, the future `01-investigacion-icp`).
- Tests:
  `tests/unit/shared/lib/db/schema-invitation-segment.test.ts` confirms the column
  type and the check constraint exist; an integration test inserts and reads back a
  row with each segment value.

### Verify

`pnpm db:migrate` applies cleanly. `pnpm type-check` clean. `pnpm vitest run` green.
Existing `organization_invitations` rows still query correctly (the new columns are
nullable).

## Phase 1 — Invite composer (recruiter-side)

### Outcome

`/settings/team` (existing page) has an "Invite a teammate" button that opens a
modal with segment + role title + company fields. The modal renders the same
four-section card the invitee will see, before the recruiter sends.

### Work

- Author `src/modules/team/components/InviteComposer.tsx`. Modal with five fields:
  email, role, segment (radio), role title (optional), company (optional). Submit
  calls the existing `POST /api/organizations/invitations` endpoint (existing route,
  `src/routes/api/organizations/invitations/index.ts`) with the new columns. The
  endpoint signature gains three optional fields.
- Update the endpoint to read the new fields and persist them. Validation: if the
  segment is provided, it must be one of the four; otherwise the row gets `NULL`
  (preserves existing behavior).
- The composer renders a `<PersonalizedCardPreview>` (a sub-component of the same
  file) that shows the segment-shaped copy + three example results. The preview
  re-uses the search endpoint with the recruiter's most-used keyword (or a sensible
  default).
- Tests:
  `tests/unit/modules/team/components/InviteComposer.test.tsx` covers the field
  validation, the segment-shaped preview, and the submit round-trip.

### Verify

`pnpm vitest run` green. E2E: a recruiter at `/settings/team` invites a teammate,
picks `hiring`, fills the role and company. The invitation row has the new
columns populated. The recruiter sees the preview card before sending.

## Phase 2 — Personalized accept page (invitee-side)

### Outcome

`/team/invite/$invitationId` (existing route) renders a four-section card instead
of a single button. The card has the workspace header, the segment-shaped
value-prop, three real example results, and the Accept / Decline controls.

### Work

- Author `src/modules/auth/components/PersonalizedInvitationPage.tsx`. Reads the
  invitation row, the `getBetaModeFlag()` (from
  [`56-beta-mode-global-pro-max-grant`](../56-beta-mode-global-pro-max-grant/spec.md)),
  and three example results from the existing `/api/search` endpoint. The page
  renders the four-section card.
- Update `src/modules/auth/components/OrganizationInvitationPage.tsx` to be a thin
  wrapper: fetch the invitation row, call `getBetaModeFlag()`, hand the typed
  props to `PersonalizedInvitationPage`. The existing state machine
  (`idle | pending | accepted | error`) and the existing accept flow are
  preserved.
- Tests:
  `tests/unit/modules/auth/components/PersonalizedInvitationPage.test.tsx`
  covers the four segments, the fallback to `other` when the segment is `NULL`,
  the beta-mode coherence, and the signed-in short-circuit
  (≤ 3 seconds before the redirect).
- Anti-enumeration test: a signed-out visitor clicking
  `/team/invite/<random-id>` sees a generic "Invitation not found" page, not the
  personalized card. The check is by invitation-id existence, not by invitee
  email.

### Verify

`pnpm vitest run` green. E2E: a signed-out visitor opens the invite link, sees
the personalized card with the segment-shaped copy and three real results, clicks
Accept, lands on `/onboarding?invite=<id>`.

## Phase 3 — Post-accept handoff to `/onboarding`

### Outcome

After accept, the invitee is redirected to `/onboarding` with the segment
pre-selected and the first keyword placeholder pre-filled. The onboarding route
already supports all three fields; this phase only changes the pre-fill source.

### Work

- Update the accept handler in `OrganizationInvitationPage` to redirect to
  `/onboarding?invite=<id>` after the accept round-trip resolves. The redirect
  happens on the existing `accepted` state.
- Update `src/routes/_dashboard/onboarding.tsx` (the onboarding route) to read the
  `invite` query param. When present, fetch the invitation row and pre-fill:
  - the segment radio (locked, with a "your recruiter picked this for you" hint),
  - the first keyword input (recruiter's most-used search, or a default per segment),
  - the persona picker (the inverse of the segment).
- The onboarding route already calls `advanceOnboarding` and `skipOnboarding`
  (`src/routes/api/onboarding/`). No change to those handlers.
- Tests:
  `tests/unit/routes/onboarding-invite-prefill.test.ts` covers the pre-fill logic
  for each segment. `tests/unit/routes/onboarding-no-invite.test.ts` confirms the
  no-invite case is unchanged.

### Verify

`pnpm vitest run` green. E2E: a signed-out visitor accepts an invitation, lands
on `/onboarding` with the segment pre-set and the keyword pre-filled.

## Phase 4 — Beta-mode coherence + verification

### Outcome

The accept page reads `getBetaModeFlag()`. When the flag is on, the value-prop
card shows the pro_max features in addition to the segment-specific bullets. The
verification report documents the before/after for every segment, with the flag
on and off.

### Work

- The accept page already reads the flag in Phase 2. Phase 4 adds the
  **pro_max feature bullets** to the value-prop card when the flag is on:
  "700 credits/month included. AI sourcing sprints (up to 10). Work-sample
  analysis." These are appended to the segment-specific bullets, not replacing
  them.
- Author `docs/operations/personalized-invitations-verification-<date>.md`. The
  file documents:
  - one row per segment (4 rows) × flag state (2 states) = 8 screenshots of the
    accept page,
  - the recruiter-side composer preview for each segment,
  - the post-accept onboarding pre-fill for each segment,
  - the verification commands (`pnpm vitest run`,
    `pnpm db:migrate --dry-run`, the e2e flow).
- Link the verification report from the plan's Status header. Flip the header to
  `closed`.

### Verify

The verification report exists. Every segment renders correctly. The flag-on case
shows the pro_max bullets; the flag-off case does not.

## Order of commits

```
feat(db): organization_invitations personalisation columns
feat(team): invite composer with segment + role title + company
feat(auth): personalised invitation accept page
feat(onboarding): pre-fill from accepted invitation
docs(invitations): verification report
```

5 commits, all reversible on their own. The schema commit is additive (existing rows
keep working). The composer commit does not change the accept endpoint's existing
behavior (the new fields are optional). The accept page commit is a refactor of an
existing component; the existing accept state machine is preserved.

## Risks

1. **Search endpoint performance.** The accept page calls `/api/search` to render
   three example results. The page is a public route (signed-out visitors see it),
   so the existing rate limit on `/api/search`
   (`src/shared/lib/rate-limit.ts`) applies. The risk is the recruiter's most-used
   search is empty (a brand-new workspace); the fallback is the segment default.
   The accept page never calls search more than once per render.
2. **Existing invitations with `NULL` segment.** Today every row has `NULL`. The
   new flow falls back to the `other` segment copy. The recruiter-side audit page
   (future work) will show how many rows are un-segmented.
3. **Beta-mode coherence.** The accept page reads the flag at render time. If the
   flag flips mid-page, the value-prop card reflects the latest fetch (the helper
   has a 60s Redis cache). This is acceptable.
4. **Anti-enumeration.** A signed-out visitor clicking a random
   `/team/invite/<random-id>` link sees a generic page. The check is by
   invitation-id existence, not by invitee email. The page does not leak whether
   the invitation exists for an arbitrary email.

## Rollback

Each phase is a single commit. `git revert <commit-hash>` returns to the prior
state. Phase 0's migration is additive — the new columns can be left populated or
empty without breaking anything. The fastest rollback is `git revert <phase-1>` (the
composer) and `git revert <phase-2>` (the accept page) — the accept page falls
back to the existing single-button page.
