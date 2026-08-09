# Personalized invitations — Tasks

> **Status**: `pending`
> **Spec**: [`spec.md`](./spec.md)
> **Plan**: [`plan.md`](./plan.md)
> **Rule**: a task is complete only when its runtime verification passes AND the existing
> accept transaction (`acceptInvitationRecord`) is unchanged. The new flow refines
> the surrounding UI only.

## Phase 0 — Schema migration

- [ ] **Author `drizzle/0143_organization_invitations_personalization.sql`**
  - Files: `drizzle/0143_organization_invitations_personalization.sql`
  - Do: ALTER TABLE adds `invitee_segment` (text, check constraint matching the
    four-segment taxonomy), `invitee_role_title` (text, nullable), `invitee_company`
    (text, nullable). All three are nullable so existing rows keep working.
  - Verify: `pnpm db:migrate` applies cleanly. Existing rows have `NULL` for the new
    columns.

- [ ] **Update `src/shared/lib/db/schema.ts`**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Export the new columns on `organizationInvitationsTable`. Re-export the segment
    enum as a Drizzle enum so callers reference the same source.
  - Verify: `pnpm type-check` clean.

- [ ] **Add `InviteeSegment` to `organizations/contracts.ts`**
  - Files: `src/shared/lib/organizations/contracts.ts`,
    `tests/unit/shared/lib/organizations/contracts.test.ts`
  - Do: Add `type InviteeSegment = 'hiring' | 'investing' | 'building' | 'other'` and the
    matching `inviteeSegmentSchema` (zod). The list is the source of truth across
    this plan, future `phase-2/06-landing-segmentada`, and
    `phase-2/01-investigacion-icp`.
  - Verify: `pnpm vitest run` green; the test pins the four values and rejects a
    fifth.

## Phase 1 — Invite composer (recruiter-side)

- [ ] **Author `InviteComposer` modal**
  - Files: `src/modules/team/components/InviteComposer.tsx`,
    `tests/unit/modules/team/components/InviteComposer.test.tsx`
  - Do: Modal with email, role, segment (radio), role title (optional), company
    (optional). Submit calls the existing
    `POST /api/organizations/invitations` endpoint with the new columns. The
    endpoint signature gains three optional fields; validation rejects an
    unknown segment.
  - Verify: tests cover field validation, the segment-shaped preview, and the
    submit round-trip.

- [ ] **Update `POST /api/organizations/invitations`**
  - Files: `src/routes/api/organizations/invitations/index.ts`,
    `src/routes/api/organizations/invitations/index.test.ts`
  - Do: Read the new fields. Persist them. If the segment is absent, persist `NULL`.
  - Verify: existing tests pass; new tests cover each segment value plus the
    `NULL` fallback.

- [ ] **Place the composer on `/settings/team`**
  - Files: `src/routes/_dashboard/settings/team.tsx`
  - Do: Replace the existing inline form (or add a button alongside it) with the
    `InviteComposer` modal trigger.
  - Verify: e2e login as a recruiter, open `/settings/team`, invite a teammate,
    pick a segment, fill the role and company, send.

## Phase 2 — Personalized accept page (invitee-side)

- [ ] **Author `PersonalizedInvitationPage`**
  - Files: `src/modules/auth/components/PersonalizedInvitationPage.tsx`,
    `tests/unit/modules/auth/components/PersonalizedInvitationPage.test.tsx`
  - Do: Reads the invitation row, `getBetaModeFlag()`, and three example results
    from `/api/search`. Renders the four-section card. Honors the signed-in
    short-circuit (≤ 3 seconds before the redirect).
  - Verify: tests cover the four segments, the `NULL`-segment fallback to
    `other`, the beta-mode coherence, and the anti-enumeration check.

- [ ] **Refactor `OrganizationInvitationPage` to a thin wrapper**
  - Files: `src/modules/auth/components/OrganizationInvitationPage.tsx`
  - Do: Fetch the invitation row, call `getBetaModeFlag()`, hand the typed
    props to `PersonalizedInvitationPage`. Preserve the existing state
    machine (`idle | pending | accepted | error`) and the existing accept flow.
  - Verify: existing tests pass; the new component renders under the same route
    file.

## Phase 3 — Post-accept handoff to `/onboarding`

- [ ] **Update the accept redirect**
  - Files: `src/modules/auth/components/OrganizationInvitationPage.tsx`
  - Do: On `accepted`, navigate to `/onboarding?invite=<id>` instead of the
    dashboard.
  - Verify: e2e login as an invitee, accept an invitation, land on
    `/onboarding` with the query param.

- [ ] **Pre-fill onboarding from the accepted invitation**
  - Files: `src/routes/_dashboard/onboarding.tsx`,
    `tests/unit/routes/onboarding-invite-prefill.test.ts`
  - Do: Read `?invite=<id>` from the query string. Fetch the invitation row.
    Pre-fill the segment radio (locked, with the "your recruiter picked this for
    you" hint), the first keyword input (recruiter's most-used search, or a
    segment default), and the persona picker (the inverse of the segment).
  - Verify: tests cover the pre-fill logic for each segment. The no-invite
    case is unchanged.

## Phase 4 — Beta-mode coherence + verification

- [ ] **Append pro_max bullets when the flag is on**
  - Files: `src/modules/auth/components/PersonalizedInvitationPage.tsx`
  - Do: When `getBetaModeFlag().enabled` is `true`, append the pro_max feature
    bullets ("700 credits/month included. AI sourcing sprints (up to 10).
    Work-sample analysis.") to the value-prop card. Segment-specific bullets
    are unchanged.
  - Verify: tests cover both flag states.

- [ ] **Manual e2e test in the dev stack**
  - Files: `docs/operations/personalized-invitations-verification-<date>.md`
  - Do: For each segment × flag state, capture a screenshot of the accept page
    and the recruiter-side composer preview. Document the post-accept onboarding
    pre-fill for each segment.
  - Verify: the file exists, lists every segment × flag state, and the
    rendering matches the spec's value-prop copy.

- [ ] **Close the plan**
  - Files: `plans/phase-1/57-personalized-invitations/`
  - Do: Update the `Status:` header in each of `spec.md`, `plan.md`,
    `tasks.md` to `closed` with a dated implementation note. Link the
    verification report.
  - Verify: every `[ ]` in `tasks.md` is checked; the plan header reflects the
    final state.
