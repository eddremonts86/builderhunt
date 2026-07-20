# Tasks: Legal & Compliance

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../waitlist-launch/spec.md)
> **Reality check**: Docs/consent/export/deletion-request flows delivered (checked below).
> Remaining: purge worker, export completeness, lifecycle emails, ops checklist.

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
- [x] **Legal lib tests** — `src/shared/lib/legal.test.ts`

## Phase 1 — Execute the promised rights

- [ ] **Deletion purge worker endpoint**
  - Files: `src/routes/api/admin/legal/run-worker.ts` (new), `src/shared/lib/legal.ts`
  - Do: POST handler modeled on `src/routes/api/admin/alerts/run-worker.ts` (admin session OR
    `x-cron-secret` header matching env `CRON_SECRET` if that pattern exists there — mirror
    it exactly). Add `processPendingDeletions()` to `legal.ts`: select `deletion_requests`
    where `status='pending'` and `grace_period_ends_at < now()`, for each call
    `performHardDelete(userId)` (`legal.ts:176`) then set `status='completed'`,
    `completed_at=now()`. Return `{ processed: n }`. Idempotent — re-runs find nothing.
  - Verify: New test in `legal.test.ts`: seed a user + expired request → run → user row gone,
    request row `completed`; run again → `processed: 0`. Then add the daily VPS cron
    (documented in `production-infrastructure` runbook task).

- [ ] **Complete the export payload**
  - Files: `src/shared/lib/legal.ts`, `src/shared/lib/legal.test.ts`
  - Do: In `buildExportPayload` (lines 70-125) also select and include: `builders` (tracked
    builders, `eq(builders.userId, userId)`), `plans` row, `plan_changes`, `plan_requests`.
    Keep the existing `toPlain` serialization. Add a test that asserts the payload object
    keys include `trackedBuilders`, `plan`, `planChanges`, `planRequests` for a seeded user.
  - Verify: `pnpm test legal` passes; request an export in dev and confirm the JSON contains
    a tracked builder created beforehand.

- [ ] **Purge cascade covers the new data**
  - Files: `src/shared/lib/legal.ts`, `src/shared/lib/legal.test.ts`
  - Do: Review `performHardDelete` deletes (or FK-cascades) every user-keyed table that now
    exists: `builders` (+`builder_notes` via cascade), `saved_queries`, `alerts` +
    `alert_triggers`, `onboarding_progress`, `user_consents`, `data_export_requests`,
    `plans`/`plan_changes`/`plan_requests`, `roadmap_votes`, `builder_profile_views`, then
    auth tables. Add any missing delete in FK-safe order.
  - Verify: Test: seed a user with one row in each table → `performHardDelete` → count 0 in
    all of them (except `deletion_requests` compliance row).

## Phase 2 — Lifecycle emails

- [ ] **Deletion + export emails via Resend**
  - Files: `src/shared/lib/email.ts`, `src/routes/api/me/delete-account/index.ts`,
    `src/routes/api/me/data-export/index.ts`
  - Do: Add three plain-text senders to `email.ts` following its existing optional-key
    pattern: deletion-scheduled (grace end date + "sign in to cancel" line), deletion-completed
    (sent by the worker before the auth row is removed — capture email first),
    export-ready (link to `/dashboard/settings/privacy`). Replace the `console.log` at
    `delete-account/index.ts:26-31` with the send (keep the log as fallback when Resend is
    unconfigured).
  - Verify: With `RESEND_API_KEY` set in dev, request deletion → email arrives; without the
    key, endpoints still return 200 and log.

## Phase 3 — Ops checklist (non-code, before launch)

- [ ] **Replace imprint placeholders with verified operator details**
  - Files: `src/routes/_landing/legal/imprint.tsx`
  - Do: Add the real operator name, contact email, and legally required address from the
    approved business record; do not infer or copy personal details from development config.
  - Verify: The production page contains no placeholder tokens and the operator approves the exact text.

- [ ] **Audit the privacy-policy processor list**
  - Files: `src/routes/_landing/legal/privacy.tsx`
  - Do: Match named processors to the deployed stack (VPS hosting and Resend today); remove
    Stripe/PostHog/Sentry claims while unused, and add MiniMax M3 plus the configured vector
    processor before their production flags are enabled per `_meta/ai-policy.md`.
  - Verify: Each named processor maps to a deployed integration and each deployed external
    processor appears in the policy with purpose and data categories.

- [ ] **Complete the DMCA registration decision and disclosure**
  - Files: `src/routes/_landing/legal/imprint.tsx`
  - Do: Have counsel/operator determine whether US DMCA agent registration applies. If it
    applies, register and publish the approved contact; otherwise record the dated rationale
    in the legal review record and do not claim registration.
  - Verify: Registration confirmation plus matching imprint text exists, or the approved
    non-applicability record is linked from the internal legal checklist.
