# Tasks: Legal & Compliance

> **Status**: `complete`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check**: All three phases done as of 2026-07-21. The deletion purge worker
> actually runs, the export payload covers tracked builders/plan/plan changes/plan requests,
> the hard-delete cascade covers builder notes/alerts/saved queries/builders, lifecycle
> emails send via the already-free-tier Resend integration, the privacy-policy processor
> list matches the real deployed stack, and the imprint has the operator's real name/address
> plus an honest DMCA-non-registration disclosure. Only non-code follow-ups remain: wiring
> the daily VPS cron to the already-live `POST /api/admin/legal/run-worker` endpoint
> (tracked in `production-infrastructure`), and the residual FK-restrict edge case noted
> inline below (rare, already fails safe).

## Phase 0 — Delivered (audited against src, 2026-07-19)

- [x] **Legal pages: terms, privacy, cookies, imprint** —
      `src/routes/_landing/legal/{terms,privacy,cookies,imprint}.tsx`, footer links
      (`src/shared/components/Footer.tsx:75-79`, incl. "Do Not Sell My Info" mailto)
- [x] **Cookie banner (accept all / essential only, localStorage)** —
      `src/shared/components/CookieBanner.tsx`, rendered in `src/routes/-root-components.tsx`
- [x] **TOS re-acceptance modal + versioned consents** — `src/shared/components/TosModal.tsx`,
      `CURRENT_CONSENT_VERSIONS`/`getConsentStatus`/`recordConsent` in `src/shared/lib/legal.ts`
- [x] **Consent API** — `src/routes/api/consent/index.ts`
- [x] **Schema: `user_consents`, `data_export_requests`, `deletion_requests`** —
      `src/shared/lib/db/schema.ts`, migrated
- [x] **Data export: synchronous build, 24h throttle, 7-day expiry** —
      `src/routes/api/me/data-export/index.ts`, `$id.ts`, `buildExportPayload` in `legal.ts`
- [x] **Account deletion request/cancel with 30-day grace** —
      `src/routes/api/me/delete-account/index.ts`, `requestDeletion`/`cancelDeletion` in `legal.ts`
- [x] **Privacy settings UI (export / delete / cancel)** —
      `src/routes/_dashboard/settings/privacy.tsx`
- [x] **Legal lib tests** — `tests/unit/shared/lib/legal.test.ts`

## Phase 1 — Execute the promised rights

- [x] **Deletion purge worker endpoint**
  - Files: `src/routes/api/admin/legal/run-worker.ts` (new), `src/shared/lib/legal.ts`
  - Do: POST handler modeled on `src/routes/api/admin/alerts/run-worker.ts` (admin-session
    auth via `ADMIN_USER_IDS` — the `x-cron-secret`/`CRON_SECRET` pattern doesn't actually
    exist in any route yet, so this mirrors the real existing convention instead). Added
    `processPendingDeletions()` to `legal.ts`: selects `deletion_requests` where
    `status='pending'` and `grace_period_ends_at < now()` (new
    `listExpiredPendingDeletionRequests` repository query), for each calls
    `performHardDelete(userId)` then sets `status='completed'`, `completed_at=now()`; a
    failed hard delete is counted as an error and leaves that request `pending` for retry.
    Returns `{ processed, errors }`. Idempotent — re-runs with nothing due return `processed: 0`.
  - **Schema fix required to make this correct**: `deletion_requests.user_id` had
    `ON DELETE CASCADE` to `auth_users.id`, which would silently delete the compliance row
    itself the moment `performHardDelete` removed the user — the row could never end up
    `completed`. Dropped that FK (migration `0019_lean_manta.sql`); the row is intentionally
    orphaned data, kept only as the audit record that a deletion happened.
  - Verify: `legal.test.ts` mocks the repository layer (this repo's env module resolves
    `DATABASE_URL` to a placeholder under vitest's `happy-dom` environment, so live-DB
    seeding tests aren't viable here — same reason no other repository test seeds real rows)
    and asserts: multiple due requests each hard-deleted and marked completed; empty due-list
    is a true no-op; a failing hard delete is counted as an error without marking the row
    completed. Admin-route boundary test in `account-privacy.test.ts` asserts admin auth and
    no caller-selected target. All passing (`pnpm test`, `pnpm type-check`, `pnpm lint`).
    Daily VPS cron still needs wiring (tracked in `production-infrastructure` runbook task).

- [x] **Complete the export payload**
  - Files: `src/shared/lib/repositories/account-privacy.ts`, `src/shared/lib/legal.ts`,
    `tests/unit/shared/lib/legal.test.ts`
  - Do: `loadAccountExportSource` now also selects `builders` (tracked builders,
    `eq(builders.userId, userId)`), the `plans` row, `plan_changes` (via the existing
    `listAccountPlanChanges`), and `plan_requests`, returned as `trackedBuilders`/`plan`/
    `planChanges`/`planRequests`. `buildExportPayload` destructures those off the account
    subject and surfaces them as top-level payload keys (not nested under
    `accountSubject`) — matches the plan's literal "payload object keys include
    trackedBuilders, plan, planChanges, planRequests" wording.
  - Verify: `legal.test.ts`'s `buildExportPayload` describe block asserts the returned
    object's keys include all four plus `accountSubject`/`exportedAt`, that each value
    matches the mocked repository data, and that the account-subject-only fields are not
    duplicated at the top level. `pnpm test`, `pnpm type-check`, `pnpm lint` all green.

- [x] **Purge cascade covers the new data**
  - Files: `src/shared/lib/repositories/account-privacy.ts`,
    `tests/unit/shared/lib/repositories/account-privacy.test.ts`
  - Do: Audited every FK referencing `auth_users.id` or `builders.id`/`saved_queries.id`
    directly (not just the table list this task originally named, which was incomplete).
    `plans`/`plan_changes`/`plan_requests`/`user_consents`/`data_export_requests`/
    `onboarding_progress`/`roadmap_votes` already `ON DELETE CASCADE` from `auth_users` —
    no code needed. `alert_triggers` already cascades from `alerts`. Two real blockers had
    no cascade and would throw a live FK violation the first time a user with any of this
    data tried to hard-delete: `builder_notes.builder_id` (blocks deleting `builders`) and
    `alerts.query_id` (blocks deleting `saved_queries`). Extended
    `hardDeleteAccountSubject`'s existing transaction with, in FK-safe order:
    `builder_notes` → `alerts` → `saved_queries` → `builders`, before the existing auth-table
    deletes.
  - **Known residual gap, intentionally not fixed here** (out of this task's scope):
    `organization_builders.creator_user_id` and `published_builder_profiles
    .published_by_user_id` are `ON DELETE RESTRICT` to `auth_users.id`. A user who created a
    shared org-tracked builder entry or published a claimed profile, then later requests
    personal-account deletion while still a non-owner org member, would hit a live Postgres
    FK violation on hard delete. `processPendingDeletions()` already catches this (counts it
    as an `errors` entry, leaves the request `pending` for manual follow-up/retry) so it
    can't crash the worker or silently corrupt data — but the underlying reassignment/
    block-and-notify product decision for that edge case is still open.
  - Verify: Since this repo's env module resolves `DATABASE_URL` to a placeholder under
    vitest's `happy-dom` test environment (no live-DB seeding is possible here — see the
    prior task's note), added a source-order test in `account-privacy.test.ts` instead:
    asserts `tx.delete(builderNotes)` → `tx.delete(alerts)` → `tx.delete(savedQueries)` →
    `tx.delete(builders)` → `tx.delete(authUsers)` appear in that literal order inside
    `hardDeleteAccountSubject`. `pnpm test`, `pnpm type-check`, `pnpm lint`, `pnpm build`
    all green (516/516 tests).

## Phase 2 — Lifecycle emails

- [x] **Deletion + export emails via Resend**
  - Files: `src/shared/lib/email.ts`, `src/routes/api/me/delete-account/index.ts`,
    `src/routes/api/me/data-export/index.ts`, `src/shared/lib/legal.ts`,
    `src/shared/lib/repositories/account-privacy.ts`
  - Do: Added three senders to `email.ts` following its existing optional-key pattern
    exactly (no new dependency, no new paid service — Resend was already integrated and
    already free-tier-capable; every sender still logs-and-returns for free when
    `RESEND_API_KEY` is unset, same as every other sender in the file):
    `sendDeletionScheduledEmail` (grace-end date + "sign in to cancel" link),
    `sendDeletionCompletedEmail` (called by `processPendingDeletions()` right after the hard
    delete succeeds — the email is captured via new `findAccountEmail(userId)` repository
    helper *before* `performHardDelete` runs, since the `auth_users` row and its email
    column are gone once that transaction commits), `sendExportReadyEmail` (link to
    `/dashboard/settings/privacy`). Replaced the `console.log` at
    `delete-account/index.ts` with `await sendDeletionScheduledEmail(...)`; wired
    `sendExportReadyEmail` after the export payload is stored as `ready` in
    `data-export/index.ts`. A failed send never fails the underlying deletion/export
    request or the purge-worker batch — logged only.
  - Verify: `legal.test.ts` (mocked `findAccountEmail`/`sendDeletionCompletedEmail`, same
    constraint as before — this repo's `env.ts` resolves to a placeholder `DATABASE_URL`
    under vitest's `happy-dom` environment) asserts: the email is captured before the hard
    delete and only sent after (`callOrder` assertion); no email sent when none was found;
    a failed send doesn't undo the completed deletion or count as a worker error. New
    `account-privacy.test.ts` boundary tests assert both routes import the right sender and
    that every new sender still has the `env.RESEND_API_KEY` check + `console.log` fallback
    (i.e. still free when unconfigured — no new paid tool introduced). 523/523 tests,
    `pnpm type-check`, `pnpm lint` (0 errors), `pnpm build` all green.

## Phase 3 — Ops checklist (non-code, before launch)

- [x] **Replace imprint placeholders with verified operator details**
  - Files: `src/routes/_landing/legal/imprint.tsx`
  - Do: Operator provided the real facts directly (2026-07-21): Eduardo Valdes Inerarte,
    individual developer, Elmevej 4, Dragør, Denmark; no company formed yet — one will be
    created before any production/paid launch outside this beta. Updated the Operator and
    Tax & registration sections accordingly; removed the stale/inconsistent "Spain (Barcelona,
    Madrid)" tax-residency line that predated this real address and didn't match it. Kept the
    "no company yet" status honestly disclosed rather than implying an LLC exists.
  - Verify: `pnpm type-check`, `pnpm lint` (0 errors), `pnpm test` (523/523), `pnpm build` all
    green. Page contains the real operator name/address, no placeholder tokens remain.
    Operator-supplied text used verbatim, not inferred.

- [x] **Audit the privacy-policy processor list**
  - Files: `src/routes/_landing/legal/privacy.tsx`
  - Do: Verified against the actual deployed stack rather than assuming: no `sentry`/
    `posthog`/`stripe` packages in `package.json` (their "we do not use X" claim was already
    true, kept as-is) — but the "we do not use ... Resend" claim was **false**: Resend is the
    app's actual transactional-email provider (claim/reset-password/invitation/alert-digest/
    deletion-and-export emails, incl. the ones added in Phase 2). Also confirmed
    `MINIMAX_API_KEY`/`AI_EMBEDDING_URL` are configured (existence-only check, no secret
    printed) and MiniMax M3 + the embedding adapter are code-complete per
    `ai-expansion`/`_meta/ai-policy.md` — both were undisclosed processors. Rewrote Section 3
    (Subprocessors): added Resend (purpose: transactional email only, console-log fallback
    when unconfigured), MiniMax M3 (purpose + explicit "never your email/password/private
    notes" boundary per ai-policy.md rule 6), and the embedding provider (public profile text
    only, no account data). Narrowed the blanket "we don't use X" line to the three still
    genuinely unused (Sentry/PostHog/Stripe). Bumped the displayed "Last updated" date; kept
    consent `version: v1.0` since this corrects a factual gap rather than changing how data
    is actually handled.
  - Verify: `pnpm type-check`, `pnpm lint` (0 errors), `pnpm test` (523/523), `pnpm build` all
    green. Every processor now named maps to a real import/env var found via grep, and every
    active integration (Postgres, Redis, the 8 public source APIs, Resend, MiniMax M3,
    embeddings) has an entry.

- [x] **Re-audit the privacy-policy processor list for Stripe (this task's own "we don't use it" claim is now stale)**
  - Files: `src/routes/_landing/legal/privacy.tsx`
  - Do: The audit above correctly said "we do not use Stripe" at the time — `package.json` had no
    `stripe` dependency then. That is no longer true: `plans/phase-1/30-stripe-billing-platform` has since
    installed `stripe@22.3.2` (pinned, `stripe-launch-register.md`) and makes real calls to the
    Stripe API today (catalog Product/Price provisioning via `scripts/billing/provision-stripe-catalog.ts`,
    webhook signature verification) — Stripe is a real processor now, even though
    `STRIPE_BILLING_ENABLED=false` still gates actual customer/payment data from flowing through it
    in production (confirmed: `billing/stripe-provider.ts`'s `getBillingProvider()` has never had a
    real Stripe-calling `BillingProvider` behind it — only `FakeBillingProvider` — so no end-user
    payment/customer data has ever actually reached Stripe through this app; only the seller's own
    catalog-provisioning calls have). Update Section 3 (Subprocessors) to name Stripe with an
    accurate purpose description, and update it again once a real adapter exists and
    `STRIPE_BILLING_ENABLED` is ever set to `true` in production (a second, larger disclosure change
    at that point — payment method data, customer records, subscription state).
  - Verify: same as the audit above — every processor claim maps to a real import/env var/API call
    found via grep, re-run `pnpm type-check && pnpm lint && pnpm test && pnpm build`.
  - Progress (2026-07-24): Executed with the operator's explicit go-ahead in chat (this was
    previously left unedited specifically because modifying public legal copy needs a human
    decision, not a silent autonomous edit). Added a `Stripe` bullet to Section 3 (Subprocessors):
    names it as the payment processor, states billing is not yet enabled for customer accounts,
    and scopes today's actual usage precisely (our own catalog provisioning + verifying Stripe's
    webhook signatures) — explicit that no customer payment method/card/subscription data is sent
    to or received from Stripe yet, and that this section will be updated again before any of that
    starts (i.e. once `STRIPE_BILLING_ENABLED` is set to `true` in production — still `false`
    today, unaffected by `stripe-billing-platform`'s `RealBillingProvider` existing in code since
    that adapter is only reachable once the flag flips). Narrowed the "we do not use X" line to
    Sentry/PostHog only. Bumped "Last updated" to 2026-07-24; kept `version: v1.0` per the same
    precedent as the prior processor-list correction (factual gap fix, not a change in how data is
    actually handled). Verified: `pnpm type-check` and `pnpm eslint` on the touched file clean;
    live-rendered at `/legal/privacy` in the dev server (dark mode) and confirmed the new bullet
    reads correctly.

- [x] **Complete the DMCA registration decision and disclosure**
  - Files: `src/routes/_landing/legal/imprint.tsx`
  - Do: Operator confirmed (2026-07-21) no DMCA agent registration exists and they were not
    previously aware of the U.S. Copyright Office registration requirement — documented as the
    non-applicable/not-yet-done state rather than claiming registration. Renamed the imprint
    section from "DMCA agent" to "DMCA / copyright reports" and added an explicit sentence:
    no formal agent has been designated with the U.S. Copyright Office; the existing email
    process is an informal reporting channel we monitor, not a registered-agent contact. Kept
    the same reporting instructions (work identification, URL, contact, good-faith/perjury
    statements, 5-business-day response) since those remain true regardless of formal
    registration status.
  - Verify: `pnpm type-check`, `pnpm lint` (0 errors), `pnpm test` (523/523), `pnpm build` all
    green. Imprint text makes no false registration claim; matches the operator's stated
    current reality.
