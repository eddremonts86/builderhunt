# Personalized invitations — segment-aware landing (spec)

> **Status**: `pending`
> **Depends on**: [`27-team-accounts`](../27-team-accounts/spec.md) (BetterAuth
> Organizations, `organization_invitations` table, accept/reject flow, role assignment —
> all implemented 2026-07-22);
> [`phase-2/02-segmentacion-usuarios`](../../phase-2/02-segmentacion-usuarios/spec.md)
> (`hiring | investing | building | other` taxonomy — pending, but the four labels are stable
> enough to land this plan against them);
> [`phase-1/56-beta-mode-global-pro-max-grant`](../56-beta-mode-global-pro-max-grant/spec.md)
> (the beta-mode flag, when on, overrides the per-org tier to `pro_max`; this plan reads
> the same flag to keep the invitation-landing entitlement coherent with what the user
> sees after they accept).
> Reads [`app-reality`](../../_meta/app-reality.md) for the invitation flow and
> BetterAuth session model today.
> **Blocks**: nothing. This plan refines an existing flow; it does not gate another plan.
> **Reality check (verified at HEAD 2026-08-07)**: `organization_invitations` exists
> (`drizzle/0001_organizations.sql:1`) with the columns `id`, `organization_id`, `email`,
> `role` (`admin | member`), `status` (`pending | accepted | rejected | canceled`),
> `expires_at`, `created_at`, `inviter_id`. There is **no** `invitee_segment`,
> `invitee_company`, `invitee_role_title`, or any other personalization column on the row.
> The accept route lives at `/team/invite/$invitationId`
> (`src/routes/team/invite/$invitationId.tsx`); the underlying page is
> `OrganizationInvitationPage` (`src/modules/auth/components/OrganizationInvitationPage.tsx`),
> which renders an `idle | pending | accepted | error` state machine and a single
> "Accept invitation" button. The page does not know who the invitee is beyond the
> invitee's email (returned only after sign-in). There is no "preview" surface today —
> a signed-out visitor sees the invitation text from the email body, not anything on the
> page. The dashboard already reads `role` for the org-side display
> (`src/modules/dashboard/components/InvitationStatusWidget.tsx`), but it never surfaces
> the invitee segment because that field does not exist.

## Problem

Today every invitation is the same shape: a recruiter sends it from `/settings/team`,
the invitee receives an email with a `/team/invite/<id>` link, lands on a single page
that says "Acme Inc. invited you to join as a member", and clicks Accept. The invitee
sees no preview of what the product does for someone like them. Conversion is gated by
how curious the invitee already is, not by how clearly the value is shown.

The maintainer's ask:

> Repensar la pantalla de aceptación por algo mucho más visual e informativo, según un
> tipo de invitación que identifica el perfil del reclutado. Mostrar el valor real, sin
> presión. Sin tono agresivo. Sin "después te vamos a cobrar".

Three concrete pain points the new flow fixes:

1. **No preview, no value-prop.** Today the page is a button. There is no "you will see
   12 source-backed results, ranked by recency, scoped to your keyword" — the invitee
   has to sign up, run a search, then decide. By the time the page is dismissed, the
   invitee has paid the click-cost without seeing anything.
2. **No segment context for the recruiter.** A recruiter inviting 50 backend engineers
   writes the same invitation as a recruiter inviting 10 founders. The recruiter cannot
   pick a persona-specific message; the invitee receives a generic one. Conversion is
   gated by the recruiter's writing skills, not by the product's value-prop.
3. **No pre-accept experience.** Once the invitee accepts, they land on the dashboard
   cold. There is no "here is what to try first, here is the kind of builder we think
   you are looking for, here is why this is interesting for someone with your role". The
   warm-up is missing.

## Goal

A segment-aware invitation flow that:

1. **Tags each invitation with an `invitee_segment`** at creation time. The recruiter
   picks one of `hiring | investing | building | other` (the four-segment taxonomy from
   [`phase-2/02-segmentacion-usuarios`](../../phase-2/02-segmentacion-usuarios/spec.md)).
   The segment is stored on `organization_invitations` and travels with the row.
2. **Renders a preview-heavy accept page**. The accept page is no longer a button.
   It is a four-section card: the recruiter's workspace (who invited, what role,
   what segment), the value-prop the segment sees first (e.g., "you will see backend
   engineers ranked by 7-day activity across 12 sources"), three example results
   (real `RawBuilder` rows from the federation, not mock data), and the call-to-action.
3. **Routes the accepted invitee to a personalized onboarding step**. After accept,
   the invitee lands on `/onboarding` with the segment pre-selected and the first
   keyword placeholder pre-filled from the recruiter's most-used search.
4. **Honors the beta-mode floor**. If
   [`phase-1/56-beta-mode-global-pro-max-grant`](../56-beta-mode-global-pro-max-grant/spec.md)
   is on, the value-prop card shows the pro_max features (sprints, work-sample,
   unlimited saved searches) instead of the per-org features. The recruiter's role
   still applies; team seats, admin surfaces, and the operator-grant path are
   unaffected.

## Non-goals

- **Not a marketing site rewrite.** This plan refines the invitation page only.
  The public landing (`/`) is a separate plan (`phase-2/08-homing-page-content-and-sections`).
- **Not per-user AB test infrastructure.** The segment is set by the recruiter, not
  inferred. Future plans can layer inference on top; this plan does not introduce it.
- **Not a new email template engine.** The invite email body grows by one or two
  sentences, but the email renderer stays the same.
- **Not a per-recipient content variation.** The recruiter picks one segment per
  invitation. If a recruiter sends 50 invitations across segments, the recruiter
  picks the segment for each row; the system does not infer it from the email or the
  role.

## Architecture

### Schema change — `organization_invitations`

Add three columns:

```sql
ALTER TABLE organization_invitations
  ADD COLUMN invitee_segment text
    CHECK (invitee_segment IS NULL OR invitee_segment IN ('hiring', 'investing', 'building', 'other')),
  ADD COLUMN invitee_role_title text,
  ADD COLUMN invitee_company text;
```

`invitee_segment` is the four-segment taxonomy. `invitee_role_title` is the
free-text role the recruiter typed when sending the invitation (e.g., "Senior Backend
Engineer", "Founding Engineer", "Head of DevRel"). `invitee_company` is the
free-text company. Both are nullable: a recruiter who uses "Send invite" without
filling the role field gets `NULL`. The check constraint on `invitee_segment` matches
the taxonomy; the other two are unconstrained text (the recruiter wrote them).

The migration ships as `drizzle/0143_organization_invitations_personalization.sql`. It is
additive; existing rows have `NULL` for all three new columns and continue to work as
they do today.

### Recruiter-side — invite composer

The recruiter opens `/settings/team` (existing page) and clicks "Invite a teammate".
A new modal opens. The modal has:

1. Email (existing field, required).
2. Role — `admin | member` (existing field, required).
3. **Segment** — radio group with four options:
   - `hiring` — "I want them to use BuilderHunt to find people" (default if the recruiter
     has used BuilderHunt for sourcing before).
   - `investing` — "I want them to map a market or evaluate builders".
   - `building` — "They are a builder themselves and may want to claim a profile".
   - `other` — "I'm not sure yet".
4. Role title — optional text, e.g., "Senior Backend Engineer".
5. Company — optional text, e.g., "Acme Inc.".

On submit, the recruiter sees the segment-shaped preview card (the same page the
invitee will see) before sending. This is the "the recruiter sees what the invitee
will see" rule from the maintainer's ask. A confirmation toggle lets them proceed or
go back and edit.

The modal lives at `src/modules/team/components/InviteComposer.tsx`. The page that
hosts the modal is `src/routes/_dashboard/settings/team.tsx`.

### Invitee-side — accept page

The accept page today (`OrganizationInvitationPage`) becomes a multi-section card:

1. **Header** — workspace name, the inviter's name, the role offered, the segment.
2. **Value-prop card** — three to five bullets keyed to the segment:
   - `hiring`: "12 sources indexed live. Recency-weighted scoring. Saved searches
     that ping you the moment a new builder matches. CSV / JSON export to Notion,
     Airtable, your ATS, or a spreadsheet. No tracking, no spam."
   - `investing`: "Track who's shipping what. Across code, conversation, and
     publishing. Map an emerging stack with one query. Identify founders by the
     stack they have shipped with, not the keywords they list on their bio."
   - `building`: "Claim your profile. Show your work where recruiters already
     look. Stop the spam — your email is not on your public profile."
   - `other`: "We don't know your job yet. Tell us — we'll show you where
     BuilderHunt fits."
3. **Three example results** — three real `RawBuilder` rows, scoped to the segment
   and a default keyword. The recruiter's most-used search keyword is used if
   available; otherwise a sensible default per segment
   (`hiring` → "rust", `investing` → "kubernetes operators", `building` → "react
   performance"). Each row shows the source, the score, and one or two activity
   signals (last commit date, last HN submission, etc.). All three rows are real —
   the page calls the existing `/api/search` endpoint. No mock data.
4. **Footer** — Accept button + "Decline" link + the segment copy ("By accepting
   you will see what 12 sources have shipped in the last 7 days").

The component is `src/modules/auth/components/PersonalizedInvitationPage.tsx`. The
existing `OrganizationInvitationPage` becomes a thin wrapper that fetches the
invitation row, calls `getBetaModeFlag()` (the
[`56-beta-mode-global-pro-max-grant`](../56-beta-mode-global-pro-max-grant/spec.md)
floor), and passes the typed props to `PersonalizedInvitationPage`.

### Post-accept — onboarding handoff

On accept, the invitee is redirected to `/onboarding` (existing route,
`src/routes/_dashboard/onboarding.tsx`). The onboarding route reads
`?invite=<id>` from the query string, fetches the invitation row, and pre-fills:

1. The segment radio (locked to the segment the recruiter picked; the invitee can
   change it but a soft hint explains "your recruiter invited you because they think
   this fits").
2. The first keyword input — pre-filled with the recruiter's most-used keyword.
3. The "I'm a builder / I'm a recruiter" picker — pre-set to the inverse of the
   invitee segment (`hiring` → "I'm a builder", `building` → "I'm a recruiter", etc.).

The onboarding flow already supports all three. The change is the pre-fill source,
not the flow itself.

### Failure modes

- **The recruiter never picks a segment.** `invitee_segment` is nullable; the accept
  page falls back to the `other` segment copy ("We don't know your job yet..."). The
  recruiter-side audit page can show how many invitations are un-segmented.
- **The invitee is already signed in.** Today the page accepts the invitation and
  redirects to the dashboard. The new flow respects that: the personalized card is
  shown for ≤ 3 seconds before the redirect.
- **The email is wrong.** The page renders the same "We don't know your job yet"
  copy as if the segment were `other`. No information leak about who invited them or
  what role was offered.

## Verification

1. **Schema migration applies cleanly.** `pnpm db:migrate` runs the new migration;
   existing rows have `NULL` for the new columns. `pnpm vitest run` green.
2. **Recruiter flow.** A test recruiter picks `hiring`, fills the role title and
   company, sends the invite. The invitation row has `invitee_segment = 'hiring'`,
   `invitee_role_title = 'Senior Backend Engineer'`, `invitee_company = 'Acme'`.
3. **Preview matches the email.** The recruiter sees the same four-section card the
   invitee will see in their inbox link preview (the email body references the same
   fields).
4. **Invitee flow.** A test invitee visits `/team/invite/<id>` while signed out. The
   page renders the four-section card with the segment-shaped value-prop and three
   example results from `/api/search`. The Accept button posts to the existing accept
   endpoint.
5. **Post-accept handoff.** After accept, the invitee lands on `/onboarding` with
   `?invite=<id>`. The segment radio is pre-set. The first keyword is pre-filled.
6. **Beta-mode coherence.** When
   [`56-beta-mode-global-pro-max-grant`](../56-beta-mode-global-pro-max-grant/spec.md)
   is on, the value-prop card shows the pro_max features (700 credits/month, 10 sprints,
   work-sample analysis) in addition to the segment-specific bullets. When off, only
   the segment bullets show.
7. **The existing accept path still works.** Invitations created before this plan
   (segment `NULL`) land on the `other` segment copy. The Accept button works the
   same way. The role assignment path is untouched.
8. **Anti-enumeration.** A signed-out visitor clicking a random
   `/team/invite/<random-id>` link gets a generic page ("Invitation not found" or
   "Sign in to continue"). The page does not leak whether the invitation exists.

## Constraints this plan respects

1. `app-reality.md` §"**Implemented features**" — every UI change reads existing data;
   no mock data, no invented searches. The example results are real federation
   output.
2. `app-reality.md` §"Auth/organizations" — the invitation row's `role` enum stays
   `admin | member`; the segment is orthogonal and lives in its own column.
3. `security-and-multitenancy` §2 — the page does not leak organization_id,
   inviter_id, or invitee_role_title across tenants. The recruiter's organization is
   the only one rendered.
4. `27-team-accounts` — the existing
   `acceptInvitationRecord(invitationId, userId)` flow is preserved. This plan
   refines the surrounding UI; it does not change the accept transaction.
5. `phase-2/02-segmentacion-usuarios` — this plan consumes the four-segment
   taxonomy; it does not invent a fifth. If `02-segmentacion-usuarios` later
   changes the labels, this plan follows.
6. `phase-1/56-beta-mode-global-pro-max-grant` — the value-prop card reads
   `getBetaModeFlag()` so the per-org entitlements stay coherent with what the user
   sees after they accept.

## Out of scope

- **Email-template redesign.** The invite email body grows by one or two sentences
  referencing the segment; the template engine stays as it is.
- **Per-invitee content variation.** One segment per invitation, set by the
  recruiter. Inference-based segmentation is a future plan.
- **Personalized onboarding redesign.** The onboarding route reads the segment; the
  flow itself is unchanged.
- **Recruiter-side analytics.** The recruiter can see how many invitations are
  pending, accepted, declined. Per-segment conversion analytics is a future plan.
