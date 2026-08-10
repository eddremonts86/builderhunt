# Personalized organization invitations — Tasks

> **Status**: `pending`
> **Depends on**: [`27-team-accounts`](../27-team-accounts/spec.md)
> **Blocks**: nothing
> **Reality check**: execute against the existing organization lifecycle and route files named
> below. The current Drizzle head is `0162_alerts_keyset_indexes`, but the migration generator owns
> the next number. This plan is canonical position `59`; `pnpm plans:check-order` must stay green.
> **Completion rule**: keep a task open until its Verify command passes. Close the plan only after
> the browser evidence and a fresh, fully green `pnpm ci:local` are recorded.

## Phase 0 — Contract and persistence

- [x] **Define the invitation-personalization contract and copy registry**
  - Files: `src/shared/lib/organizations/invitation-personalization.ts`,
    `tests/unit/shared/lib/organizations/invitation-personalization.test.ts`
  - Do: Export `INVITATION_INTENTS`, `InvitationIntent`, strict input normalization,
    labels, three capability bullets per intent, email lead copy, and
    `INVITATION_SUGGESTED_QUERY`. Missing intent becomes `other`; trim `roleTitle`, convert an
    empty value to `null`, and reject values over 120 characters. Type every per-intent map as
    `Record<InvitationIntent, ...>` so additions fail type checking until all consumers are
    complete.
  - Verify: `pnpm vitest run tests/unit/shared/lib/organizations/invitation-personalization.test.ts --maxWorkers=11`
    and `pnpm type-check` pass; tests cover all four values plus missing, whitespace-only,
    120-character, 121-character, and unknown-intent inputs.

- [x] **Add constrained nullable columns through a generated migration**
  - Files: `src/shared/lib/db/schema.ts`, the newly generated
    `drizzle/*_invitation_personalization.sql`, its matching
    `drizzle/meta/*_snapshot.json`, `drizzle/meta/_journal.json`,
    `drizzle/migration-hashes.json`,
    `tests/unit/shared/lib/db/schema-invitation-personalization.test.ts`
  - Do: Add nullable `invitationIntent` (`invitation_intent`) and `roleTitle`
    (`invitee_role_title`) fields with the intent allowlist and trimmed 1..120 title checks.
    Confirm the latest journal entry immediately before running
    `pnpm exec drizzle-kit generate --name invitation_personalization`; accept only the number allocated by
    Drizzle. Inspect the generated SQL and remove no existing column, index, policy, or grant.
    Regenerate the immutable manifest with
    `node scripts/db/verify-migration-integrity.mjs --write` only after the SQL is final.
  - Verify: `pnpm test:migration-integrity`, `pnpm test:migrations:local`, and
    `pnpm vitest run tests/unit/shared/lib/db/schema-invitation-personalization.test.ts --maxWorkers=11`
    pass. The schema/SQL tests pin column names, nullability, all four allowed values,
    invalid-value rejection, trimming checks, and null defaults for legacy rows.

- [x] **Carry personalization through create, deduplication, reads, and resend**
  - Files: `src/shared/lib/auth/organization-lifecycle.ts`,
    `tests/unit/shared/lib/auth/organization-lifecycle.test.ts`
  - Do: Extend `InvitationRecord`, `LifecycleDependencies.createInvitation`, database inserts,
    projections, `findPendingInvitation`, `listInvitationsForEmail`, and page projections with
    nullable personalization. Normalize new creates before persistence. Resend must copy both
    fields to the fresh row; a duplicate pending race must return the winning row without
    overwriting context or sending another email, with `deduplicated: true`; new rows return
    `deduplicated: false`. Do not change the pending unique index or seat accounting.
  - Verify: `pnpm vitest run tests/unit/shared/lib/auth/organization-lifecycle.test.ts --maxWorkers=11`
    passes with assertions for new, legacy-null, resend, and conflicting-concurrent-create paths;
    the existing duplicate-email and seat-limit tests remain green.

## Phase 1 — Recipient authorization and HTTP contracts

- [x] **Add one recipient-eligibility boundary for review, accept, and reject**
  - Files: `src/shared/lib/auth/organization-lifecycle.ts`,
    `tests/unit/shared/lib/auth/organization-lifecycle.test.ts`
  - Do: Factor the authenticated, verified-email, normalized-email-match, pending, and unexpired
    predicate into a private lifecycle helper. Add `reviewInvitation(request, invitationId)` and
    `rejectInvitation(request, invitationId)`. Reject through a new dependency that conditionally
    updates only a pending row and reports whether one row changed. Every invalid or raced case
    must throw exactly `OrganizationLifecycleError('This invitation is no longer valid', 403)`.
    Rate-limit review/reject by user ID and emit redacted allow/deny audit events without email,
    title, query, or other invitation data in `details`.
  - Verify: `pnpm vitest run tests/unit/shared/lib/auth/organization-lifecycle.test.ts --maxWorkers=11`
    passes a table-driven matrix for missing, expired, accepted, canceled, rejected, wrong-email,
    unverified, and valid rows, plus the accept-vs-reject loser behavior.

- [x] **Publish allowlisted invitation DTOs**
  - Files: `src/shared/lib/organizations/contracts.ts`,
    `tests/unit/shared/lib/organizations/contracts.test.ts`
  - Do: Add `InvitationReviewDto` and serializers that convert a null stored intent to `other` and
    expose only `organizationName`, `role`, `intent`, `roleTitle`, and ISO `expiresAt`. Extend
    owner-visible invitation summaries only if the Team invitation grid actually consumes a new
    field; otherwise keep that DTO unchanged. Never serialize email, organization ID, inviter ID,
    or a raw lifecycle record to the recipient.
  - Verify: `pnpm vitest run tests/unit/shared/lib/organizations/contracts.test.ts --maxWorkers=11`
    passes exact-key assertions for personalized and legacy rows and proves forbidden fields are
    absent.

- [x] **Validate and persist the extended create request**
  - Files: `src/routes/api/organizations/invitations/index.ts`,
    `tests/e2e/api/organizations-invitations.spec.ts`
  - Do: Make the authenticated body schema strict and accept optional `intent` and `roleTitle` in
    addition to existing email/role. Feed normalized values to `inviteMember`; keep organization
    and inviter session-derived. Unknown keys, organization/inviter injection, invalid intent, and
    a 121-character title return `400 Invalid body` only after authentication. Preserve the current
    response and dev-link behavior while adding the lifecycle's `deduplicated` marker.
  - Verify: `pnpm playwright test tests/e2e/api/organizations-invitations.spec.ts --project=chromium --workers=11`
    passes new valid/boundary/hostile-body cases plus the existing auth-before-validation,
    cross-tenant, duplicate-race, exact `deduplicated` values, seat-limit, resend, and audit
    assertions.

- [x] **Add recipient review and reject routes**
  - Files: `src/routes/api/organizations/invitations/$invitationId/review.ts`,
    `src/routes/api/organizations/invitations/$invitationId/reject.ts`,
    `src/routeTree.gen.ts`, `tests/e2e/api/organizations-invitations.spec.ts`
  - Do: Implement GET-only review and POST-only reject routes as thin lifecycle/DTO adapters.
    Preserve the generic lifecycle error and status without logging invitation contents. Register
    `ANY: methodNotAllowed(...)` with the exact allowlist. Let the router generator update
    `src/routeTree.gen.ts`; do not hand-edit generated route declarations.
  - Verify: `pnpm build`, `pnpm security:route-methods`, and
    `pnpm playwright test tests/e2e/api/organizations-invitations.spec.ts --project=chromium --workers=11`
    pass. API cases prove a valid recipient can review/reject, all invalid identities/states return
    the same 403 body, rejected rows cannot be accepted, and no response contains forbidden keys.

- [x] **Return truthful organization activation after acceptance**
  - Files: `src/shared/lib/auth/organization-lifecycle.ts`,
    `src/routes/api/organizations/invitations/$invitationId/accept.ts`,
    `tests/unit/shared/lib/auth/organization-lifecycle.test.ts`,
    `tests/e2e/api/organizations-invitations.spec.ts`
  - Do: Keep `acceptInvitationRecord(invitationId, userId)` as one atomic conditional-update and
    membership-insert transaction, but return whether it transitioned the pending row so an
    accept/reject race cannot report false success. Return the intent-derived suggested query with
    `organizationId` only after commit. In the route, after acceptance,
    invoke the existing `switchActiveOrganization` lifecycle operation. Return
    `{ ok, organizationId, activeOrganization: true, suggestedQuery }` on success. Catch switch
    failure separately, log only a redacted error, and return the same 200 body with
    `activeOrganization: false`; never report an already committed membership as a failed accept.
  - Verify: `pnpm vitest run tests/unit/shared/lib/auth/organization-lifecycle.test.ts --maxWorkers=11`
    and `pnpm playwright test tests/e2e/api/organizations-invitations.spec.ts --project=chromium --workers=11`
    pass with exact-response assertions for activation success/failure, one membership row in
    both cases, unchanged `acceptInvitationRecord` inputs, a generic error for a lost
    state-transition race, and no switch attempt when acceptance fails.

## Phase 2 — Email and sender experience

- [x] **Personalize the organization invitation email safely**
  - Files: `src/shared/lib/email.ts`,
    `src/shared/lib/auth/organization-lifecycle.ts`,
    `tests/unit/shared/lib/email.test.ts`,
    `tests/unit/shared/lib/email-invitation.test.ts`,
    `tests/e2e/harness/fakes/email.spec.ts`
  - Do: Pass normalized intent/title through `sendInvitationEmail` to
    `sendOrganizationInvitationEmail`. Add the shared intent lead and optional role title while
    retaining the subject, CTA, seven-day guidance, E2E outbox, Resend, and dev-link branches.
    Escape organization name, title, and URL; never log recipient or bearer link. Resend emails
    must use the copied personalization from the fresh row.
  - Verify: `pnpm vitest run tests/unit/shared/lib/email.test.ts tests/unit/shared/lib/email-invitation.test.ts tests/e2e/harness/fakes/email.spec.ts --maxWorkers=11`
    passes all four intent variants, legacy fallback, hostile HTML/title input, resend, outbox,
    and no-secret-log assertions.

- [x] **Build the shared static invitation value preview**
  - Files: `src/shared/components/organizations/InvitationValuePreview.tsx`,
    `tests/unit/shared/components/organizations/InvitationValuePreview.test.tsx`
  - Do: Render organization/role/title context when supplied, three capabilities for the selected
    intent, and its suggested first search. Keep the component pure: props in, markup out; no
    fetch, entitlement read, image beacon, timers, or storage. Phrase role title as
    sender-provided context. Use semantic headings/lists and token classes at mobile and desktop
    widths.
  - Verify: `pnpm vitest run tests/unit/shared/components/organizations/InvitationValuePreview.test.tsx --maxWorkers=11`
    passes exact copy for every intent, legacy fallback, omitted title, accessible structure, and
    a fetch spy asserting zero network calls.

- [x] **Replace the Team inline form with a reviewed invitation composer**
  - Files: `src/modules/dashboard/components/TeamInvitationComposer.tsx`,
    `src/modules/dashboard/components/TeamSettingsPage.tsx`,
    `src/routes/_dashboard/settings/team.tsx`,
    `tests/unit/modules/dashboard/components/TeamInvitationComposer.test.tsx`,
    `tests/unit/modules/dashboard/components/TeamSettingsPage.test.tsx`
  - Do: Implement a two-step `Dialog`: details (email, membership role, required intent defaulting
    to `other`, optional 120-character title) then shared preview. Change `onInvite` to one typed
    input object and post the extended body from the route. Preserve permission/seat gating,
    invitation paging, resend/cancel, mutation errors, snapshot refresh, and dev-link capture.
    Disable repeat submit, retain entered values after server error, focus the first error, and
    return focus to the trigger on close. When `deduplicated` is true, show that the already-pending
    invitation won and that no new email or personalization was applied.
  - Verify: `pnpm vitest run tests/unit/modules/dashboard/components/TeamInvitationComposer.test.tsx tests/unit/modules/dashboard/components/TeamSettingsPage.test.tsx --maxWorkers=11`
    passes keyboard, focus, validation, edit/review, exact payload, double-submit, error-retention,
    permission, full-seat, deduplicated notice, and dev-link cases.

## Phase 3 — Recipient experience and onboarding

- [x] **Render secure personalized review, accept, and decline states**
  - Files: `src/modules/auth/components/OrganizationInvitationPage.tsx`,
    `tests/unit/modules/auth/components/OrganizationInvitationPage.test.tsx`,
    `tests/e2e/auth-and-sessions.spec.ts`, `tests/e2e/team-accounts.spec.ts`
  - Do: Preserve the current session-hydration confirmation and exact sign-in return URL. After a
    signed-in session exists, GET the review DTO and render `InvitationValuePreview`. Add loading,
    retryable network error, generic invalid, accept-pending, reject-confirmation, reject-pending,
    accepted, activation-fallback, and rejected states with live regions. Keep
    `invitation-accept-btn`; add stable review/decline test IDs. Do not auto-accept, use timed
    redirects, or reveal distinct invalid reasons. On successful acceptance, trust only the
    server response: active organization goes to onboarding; inactive goes to dashboard.
  - Verify: `pnpm vitest run tests/unit/modules/auth/components/OrganizationInvitationPage.test.tsx --maxWorkers=11`
    and `pnpm playwright test tests/e2e/auth-and-sessions.spec.ts tests/e2e/team-accounts.spec.ts --project=chromium --workers=11`
    pass signed-out return, stale-session recovery, wrong/unverified account, legacy-null, review,
    accept, decline, replay, request failure, and activation-fallback cases.

- [x] **Prefill the existing onboarding search from validated query state**
  - Files: `src/routes/onboarding/search.tsx`,
    `tests/unit/routes/onboarding-search.test.tsx`, `tests/e2e/onboarding.spec.ts`
  - Do: Add route search validation for optional `q`, trimming it and bounding it to 300
    characters, and initialize the editable query field from it. Acceptance navigates with the
    encoded server-returned suggested query. Do not auto-run, auto-save, persist an intent/user
    segment, or alter no-query visits. Keep skip and back behavior unchanged.
  - Verify: `pnpm vitest run tests/unit/routes/onboarding-search.test.tsx --maxWorkers=11` and
    `pnpm playwright test tests/e2e/onboarding.spec.ts --project=chromium --workers=11` pass for
    valid prefill, edited prefill, empty/overlong/untrusted values, no-query regression, explicit
    search submission, back, and skip.

- [x] **Add the end-to-end personalized invitation security journey**
  - Files: `tests/e2e/personalized-organization-invitations.spec.ts`,
    `tests/e2e/api/organizations-invitations.spec.ts`
  - Do: Use the real E2E database, roles, email outbox, and HTTP routes to cover sender compose and
    preview, delivered link, signed-out redirect and return, recipient review, accept, active-org
    onboarding prefill, decline, legacy-null, resend, duplicate personalization winner,
    wrong-account/unverified/fabricated/expired/replayed IDs, and concurrent accept-vs-reject.
    Assert the invitation page makes no request to `/api/search`, provider hosts, or external
    images. Exercise desktop and mobile viewport plus keyboard-only accept/decline.
  - Verify: `pnpm playwright test tests/e2e/personalized-organization-invitations.spec.ts tests/e2e/api/organizations-invitations.spec.ts --project=chromium --project=mobile --workers=11`
    passes with strict browser-error guards and no allowlisted unexpected 4xx/5xx response.

## Phase 4 — Gates and evidence

- [ ] **Run security, migration, and static quality gates**
  - Files: `docs/operations/personalized-invitations-verification.md`
  - Do: Record the current commit/worktree scope and run migration integrity/replay, RLS, tenant
    boundaries, auth-before-validation, route client boundaries, route methods, UI route graph,
    type checking, lint, and build. Record exact exit codes and distinguish unrelated dirty-tree
    failures rather than suppressing them. Resolve every failure caused by this feature before
    proceeding.
  - Verify: `pnpm test:migration-integrity`, `pnpm test:migrations:local`,
    `pnpm test:rls:local`, `pnpm security:boundaries`,
    `pnpm security:auth-before-validate`, `pnpm security:route-client-boundary`,
    `pnpm security:route-methods`, `pnpm security:ui-route-graph`, `pnpm type-check`,
    `pnpm lint`, and `pnpm build` all exit 0 and their results are copied into the evidence file.

- [ ] **Verify the complete flow manually and close only on the full gate**
  - Files: `docs/operations/personalized-invitations-verification.md`,
    `plans/phase-1/59-personalized-invitations/spec.md`,
    `plans/phase-1/59-personalized-invitations/plan.md`,
    `plans/phase-1/59-personalized-invitations/tasks.md`
  - Do: In the real local browser, execute sender preview/send, outbox link, signed-out sign-in
    return, recipient review, accept, organization activation, onboarding prefill, decline,
    wrong-account, legacy-null, and simulated activation-fallback flows at mobile and desktop
    widths. Capture screenshots and accessibility/keyboard observations. Then run a fresh
    `pnpm ci:local`. Only after it is completely green, record dated evidence, check every task,
    and change all three status headers to `implemented`.
  - Verify: the evidence file maps every acceptance criterion to a screenshot/test/command and
    includes a zero exit code for the final `pnpm ci:local`; `rg -n '^- \[ \]' plans/phase-1/59-personalized-invitations/tasks.md`
    returns no matches after closure.

## Explicitly deferred

These items require separate specifications and are not implementation tasks for this plan:

- authoritative per-user segments or preference storage;
- conversion analytics, experiments, or per-intent reporting;
- tier/beta entitlement advertising before acceptance;
- recruiter search-history sharing;
- live people/results previews on invitation surfaces;
- custom sender messages, employer/company collection, or inviter-profile display.
