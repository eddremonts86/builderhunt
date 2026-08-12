# Personalized organization invitations — Specification

> **Status**: `implemented`
> **Depends on**: [`27-team-accounts`](../27-team-accounts/spec.md)
> **Blocks**: nothing
> **Reality check**: verified against HEAD on 2026-08-09. Organization invitations are
> created by `POST /api/organizations/invitations`, accepted at
> `/team/invite/$invitationId`, and persisted through
> `src/shared/lib/auth/organization-lifecycle.ts`. Signed-out visitors are redirected to
> sign-in before the page reveals anything. Onboarding is the route tree under
> `src/routes/onboarding/`; there is no `_dashboard/onboarding.tsx`. The migration head is
> `0162_alerts_keyset_indexes`, so implementation must generate the next migration rather
> than reserve an old number. This plan was renumbered from `57` to `59` on 2026-08-09
> because `56-UI` and `57-ui-dashboard` already owned those canonical queue positions.

## Problem

The existing membership-invitation page is secure and functional, but it gives a verified
invitee little context beyond the account they are signed in with and an Accept button. An
administrator cannot explain which BuilderHunt workflow is relevant to the person being
invited, and acceptance drops the new member into the dashboard without a useful first
search.

The original draft tried to solve this with a public, data-heavy landing page. That design
would have exposed organization and employment context to anyone holding or guessing an
invitation URL, called authenticated federation endpoints from a signed-out surface, and
made dynamic entitlement promises before membership existed. This specification preserves
the value-preview goal without weakening the invitation boundary.

## Goal

Deliver a calm, visual invitation flow in which:

1. An authorized organization owner or admin selects an invitation intent and may add a
   short role-title hint before sending.
2. The sender reviews the same intent-specific value card the recipient will see.
3. A signed-in, email-verified recipient whose session email matches the pending invitation
   can review the organization name, offered membership role, optional role-title hint, and
   intent-specific product capabilities before accepting or declining.
4. Acceptance preserves the existing atomic membership transaction, activates the accepted
   organization when possible, and starts the existing onboarding search with a safe,
   deterministic suggested query.
5. Existing invitations with no personalization remain valid and use the neutral `other`
   experience.

## Non-goals

- No public invitation preview. Signed-out and wrong-account visitors learn no invitation
  details.
- No live search, real-person results, avatars, or third-party/provider requests on the
  invitation review page or sender preview.
- No recruiter-most-used-query lookup. Search history is tenant-private and is not copied
  into an invitation.
- No authoritative user segmentation. The sender's choice is invitation context only; it
  does not write a user preference, lock onboarding choices, or infer identity.
- No employment-profile collection. Company is omitted because the organization name
  already supplies workspace context and an extra employer field would be redundant PII.
- No beta-mode or plan-tier marketing. Effective entitlements can change, and the invitee
  is not a member until acceptance. The card describes shipped cross-tier capabilities only.
- No invitation conversion dashboard or A/B framework.

## Domain model

### Invitation intent

This plan owns a small invitation-specific vocabulary. It does not depend on the pending
phase-2 user-segmentation plan.

```ts
export const INVITATION_INTENTS = [
  "hiring",
  "investing",
  "building",
  "other",
] as const;
export type InvitationIntent = (typeof INVITATION_INTENTS)[number];

export interface InvitationPersonalization {
  intent: InvitationIntent;
  roleTitle: string | null;
}
```

Semantics:

| Intent      | Sender meaning                       | Recipient value focus                               | Suggested query              |
| ----------- | ------------------------------------ | --------------------------------------------------- | ---------------------------- |
| `hiring`    | Find and evaluate technical people   | multi-source discovery, recency, saved searches     | `backend engineers`          |
| `investing` | Map a technical market               | shipped-work signals, stack and ecosystem discovery | `AI infrastructure founders` |
| `building`  | Improve a builder's visibility       | claimable profiles and work-based identity          | `developer tools`            |
| `other`     | General collaboration or unknown fit | neutral product overview                            | `open source builders`       |

`src/shared/lib/organizations/invitation-personalization.ts` is the sole client-safe
source for the values, labels, capability copy, suggested queries, and normalization.
Copy consumers must import this module instead of duplicating maps.

### Database change

Add two nullable columns to `organization_invitations`:

```sql
invitation_intent text null,
invitee_role_title text null
```

Database constraints provide defense in depth:

- `invitation_intent IS NULL OR invitation_intent IN ('hiring', 'investing',
'building', 'other')`.
- `invitee_role_title IS NULL OR (invitee_role_title = btrim(invitee_role_title)
AND char_length(invitee_role_title) BETWEEN 1 AND 120)`.

Columns stay nullable for old rows. New API requests normalize an omitted intent to
`other`, trim `roleTitle`, and convert an empty title to `NULL`. No index is required: the
fields are read only after locating an invitation by primary key or within an existing
tenant-scoped invitation query.

The table remains tenant-private and `FORCE ROW LEVEL SECURITY` remains unchanged. Reads and
writes continue through the Better Auth broker role and the organization lifecycle. The
migration must be generated from the then-current head and must include its SQL, snapshot,
journal entry, and migration-hash manifest update. Applied migrations are immutable.

## Contracts and authorization

### Create request

`POST /api/organizations/invitations` keeps the organization server-derived from the
principal and accepts:

```ts
interface CreateOrganizationInvitationBody {
  email: string;
  role: "admin" | "member";
  intent?: InvitationIntent; // omitted legacy clients normalize to `other`
  roleTitle?: string | null; // trimmed, 1..120 chars after trimming
}
```

The Zod object is strict. Unknown keys, client-supplied organization/inviter IDs, invalid
intents, and overlong titles return the existing generic `400 { error: 'Invalid body' }`
after authentication. Duplicate concurrent invites keep the existing database-enforced
winner semantics; the first pending row and its personalization win, and no second email is
sent. The create response includes `deduplicated: boolean`. When true, the sender UI states
that an invitation was already pending and that no new email or personalization was applied;
it must not present the request as a newly sent invitation.

Resend cancels the old invitation and creates a fresh ID while copying `intent` and
`roleTitle`. Cancel behavior is unchanged.

### Recipient review

Add `GET /api/organizations/invitations/$invitationId/review`. It requires a session,
verified email, a pending unexpired invitation, and an exact normalized email match. Every
missing, expired, used, unverified, or wrong-account case returns the same status and message
as acceptance: `403 { error: 'This invitation is no longer valid' }`.

The allowlisted response is:

```ts
interface InvitationReviewDto {
  organizationName: string;
  role: "admin" | "member";
  intent: InvitationIntent; // NULL rows serialize as `other`
  roleTitle: string | null;
  expiresAt: string;
}
```

It never returns invitee email, organization ID, inviter ID/name, another invitation, raw
database rows, or entitlement details. Review attempts are rate-limited by authenticated
user ID and denied attempts use the existing redacted security-audit path.

### Accept and decline

`POST /api/organizations/invitations/$invitationId/accept` retains the existing transaction
boundary and conditional `pending` update. `acceptInvitationRecord(invitationId, userId)` is
extended to report whether it actually transitioned the row; a lost accept/reject race receives
the generic invalid response instead of false success. The successful response expands to:

```ts
interface AcceptInvitationResponse {
  ok: true;
  organizationId: string;
  activeOrganization: boolean;
  suggestedQuery: string;
}
```

After membership is committed, the route attempts the existing organization-switch
lifecycle operation. A switch failure must not turn an already accepted invitation into an
apparent failed acceptance: return `200` with `activeOrganization: false`, log a redacted
server error, and send the client to `/dashboard`, where the organization switcher remains
available. When activation succeeds, navigate to `/onboarding/search?q=<encoded query>`.

Add `POST /api/organizations/invitations/$invitationId/reject`. It applies the same recipient
validation, atomically changes only `pending` to `rejected`, emits a redacted audit event,
and returns `{ ok: true }`. All invalid cases use the same generic 403 response. Declining
does not create membership or activate an organization.

## User experience

### Sender composer

`/settings/team` keeps the current permission, seat-limit, mutation-error, dev-link, and
refresh behavior. The inline form becomes a two-step accessible dialog:

1. **Details** — required email, existing membership role, required invitation intent
   defaulted to `other`, and optional role title with a visible `120`-character limit.
2. **Review** — organization name, role, optional role title, and the intent's capability
   card. Back edits; Send submits once. Pending and success states prevent double submit and
   restore focus to the trigger on close.

The preview contains capability descriptions, not fake people or synthetic metrics. It makes
no tier-specific numerical promises. The existing dev-only manual-share link remains visible
after a successful send.

### Recipient review page

The route preserves the current signed-out redirect contract:
`/auth/sign-in?redirect=/team/invite/<id>`. After session hydration, it fetches the review
DTO. Only a valid recipient sees:

1. Organization name and offered membership role.
2. Optional role-title context, explicitly phrased as sender-provided context rather than a
   verified profile fact.
3. Three concise intent-specific capabilities and the suggested first search.
4. Primary **Accept invitation** and secondary **Decline** controls.

There is no timed redirect or automatic acceptance. Loading, invalid, offline, acceptance,
activation-fallback, and decline states use stable live regions and preserve the generic
anti-enumeration copy. The card works at mobile and desktop widths and supports keyboard-only
operation and reduced motion.

### Onboarding handoff

`src/routes/onboarding/search.tsx` gains a validated optional `q` search parameter (trimmed,
maximum 300 characters) and uses it only as the initial input value. It does not treat the
query as authorization or persist it
until the user explicitly runs the search. Existing visits without `q` are byte-for-byte
equivalent in behavior, and the remaining onboarding steps stay unchanged.

## Email

`sendOrganizationInvitationEmail` receives the normalized personalization. Subject, link,
expiry, and sign-in guidance stay unchanged. The body adds one short intent-specific sentence
and the optional escaped role title. All variants use the shared copy model, escape user- and
organization-provided text, preserve the E2E outbox seam, and never log recipient data or
invitation URLs.

## Failure and compatibility rules

| Case                                                    | Required behavior                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Legacy row has both new columns `NULL`                  | Review renders `other`; accept/resend still work.                                         |
| Signed-out visitor                                      | Redirect to sign-in with the exact invitation return path; reveal nothing.                |
| Wrong or unverified account                             | Generic 403; no organization, role, title, intent, or validity leak.                      |
| Expired, canceled, rejected, accepted, or fabricated ID | Same generic 403 and UI state.                                                            |
| Review fetch is offline                                 | Retryable generic error; no accept/decline request is guessed.                            |
| Duplicate concurrent create                             | Existing pending row wins; original personalization and email remain authoritative.       |
| Resend                                                  | Fresh ID; personalization copied; stale link remains invalid.                             |
| Accept succeeds, organization activation fails          | Membership stays accepted; response says `activeOrganization: false`; dashboard fallback. |
| Decline races with accept                               | Exactly one pending-state transition wins; loser gets the generic invalid response.       |
| Tampered onboarding `q`                                 | Treated as editable text only; no permission or database write.                           |

## Acceptance criteria

1. All new invitations persist a normalized intent; legacy rows remain usable.
2. Sender preview and recipient card are driven by one shared intent/copy module and render
   the same capability content.
3. No unauthenticated, wrong-account, unverified, expired, or replayed request receives any
   invitation detail.
4. The invitation page makes zero calls to search/provider endpoints and renders no real-person
   preview data.
5. Create, review, accept, decline, cancel, resend, duplicate-race, and legacy-null paths have
   unit/API coverage; the signed-out round trip and full sender-to-onboarding flow have E2E
   coverage.
6. Acceptance keeps the existing membership transaction boundary and inputs, reports a lost
   pending-state race, and activates the organization only after membership commits.
7. On successful activation, the new member reaches `/onboarding/search` with the server-owned
   suggested query prefilled. Activation failure has a truthful dashboard fallback.
8. Email variants are escaped, outbox-testable, and contain no unsupported tier or usage claims.
9. Migration integrity, RLS isolation, route-method coverage, type checking, lint, unit tests,
   E2E tests, and the complete `pnpm ci:local` gate pass before closure.
10. A deduplicated create is truthful in both API and UI: it sends no second email, preserves the
    winning row, and tells the sender that their new context was not applied.

## Success indicators

The implementation is successful when the acceptance criteria are green and a manual browser
pass confirms that a first-time invitee can understand the organization, expected role, product
value, and next action without pressure. Conversion analytics are deliberately deferred until a
separate plan defines consent, event vocabulary, sample size, and retention.
