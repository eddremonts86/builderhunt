# Tasks — self-managed profiles

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../02-segmentacion-usuarios/spec.md),
> [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md),
> [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md),
> [`06-landing-segmentada`](../06-landing-segmentada/spec.md),
> [`phase-1/36-claimable-profiles`](../../phase-1/36-claimable-profiles/spec.md),
> [`phase-1/37-portfolio-builder`](../../phase-1/37-portfolio-builder/spec.md), and
> [`phase-1/38-work-sample`](../../phase-1/38-work-sample/spec.md)
> **Blocks**: nothing
> **Reality check**: The original 83-item checklist predated the current schema tip (`0154`), the
> production document pipeline in `src/lib/storage/`, the account data-export API, and the removal
> of two network sources. The tasks below are the executable contract. Reuse the document pipeline;
> do not create a second storage, MIME-validation, ClamAV, or signed-download implementation.

Execute top to bottom. Each task ends in a reviewable, independently testable deliverable.

## Phase 0 — canonical model and ownership

- [ ] **Add the account-subject profile and attachment schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/*.sql` (new migration allocated by
    `pnpm db:generate`), `drizzle/migration-hashes.json`,
    `docs/architecture/data-classification.md`
  - Do: add `self_managed_profiles`, `self_managed_attachments`, and
    `self_managed_handle_reservations` with the complete columns and constraints from `spec.md`.
    Profiles are account-subject data keyed by `owner_user_id`; public reads expose only the public
    projection. Add forced RLS, app/worker grants, ownership policies using server-set user context,
    unique active handle/owner constraints, organization-independent deletion semantics, and a safe
    forward-only migration. Let `pnpm db:generate` allocate the migration number.
  - Verify: `pnpm test:migrations:local`, `pnpm test:migration-integrity`, and a negative DB test
    proving user A cannot select or mutate user B's draft/unlisted profile or attachments.

- [ ] **Implement schemas, service taxonomy, and repositories**
  - Files: `src/shared/lib/self-managed/contracts.ts`,
    `src/shared/lib/self-managed/service-taxonomy.ts`,
    `src/shared/lib/repositories/self-managed-profiles.ts`,
    `src/shared/lib/repositories/self-managed-attachments.ts`,
    `tests/unit/shared/lib/repositories/self-managed-profiles.test.ts`,
    `tests/unit/shared/lib/repositories/self-managed-attachments.test.ts`
  - Do: define strict Zod request/public DTO schemas and the versioned service taxonomy. Implement
    owner-resolved CRUD, visibility transitions, handle reservation expiry, attachment lifecycle,
    and bounded retention batches. Repository writes take the authenticated user from server context;
    no public method accepts an authority-bearing `ownerUserId` from a request DTO.
  - Verify: `pnpm test tests/unit/shared/lib/repositories/self-managed-profiles.test.ts
    tests/unit/shared/lib/repositories/self-managed-attachments.test.ts`; include create/update/delete,
    expired reservation, duplicate owner/handle, invalid transition, and cross-user negative cases.

## Phase 1 — uploads on the existing document pipeline

- [ ] **Extend the existing quarantine and scanning pipeline for profile attachments**
  - Files: `src/lib/storage/document-validation.ts`, `src/lib/storage/object-keys.ts`,
    `src/lib/storage/provider.ts`, `src/lib/storage/clamav.ts`,
    `src/lib/scheduling/document-worker.ts`,
    `tests/unit/lib/storage/document-validation.test.ts`,
    `tests/unit/lib/scheduling/document-worker.test.ts`
  - Do: add the self-managed attachment policy (allowed MIME types, 25 MB cap, 12 active files,
    one active CV) as a caller-specific policy over the existing validators and provider. Use the
    existing `quarantine/` → `clean/` promotion and fail-closed scanner behavior. Generalize the
    worker only where needed; do not fork ClamAV, S3 signing, magic-byte validation, or object-key
    safety into a second storage tree.
  - Verify: unit tests reject MIME/magic-byte mismatch and EICAR, keep failed scans quarantined,
    promote a clean object, enforce both quotas, and prove object keys never contain user filenames.

- [ ] **Expose upload intent, completion, download, and deletion routes**
  - Files: `src/routes/api/self-managed/attachments/index.ts`,
    `src/routes/api/self-managed/attachments/$attachmentId/complete.ts`,
    `src/routes/api/self-managed/attachments/$attachmentId/download.ts`,
    `src/routes/api/self-managed/attachments/$attachmentId/index.ts`,
    `tests/e2e/self-managed-profile.spec.ts`
  - Do: follow the proven scheduling-document flow: authenticated intent creates an
    `awaiting_upload` row and presigned PUT; completion verifies real length/hash/magic bytes and
    moves to `pending`; the worker scans; download issues a five-minute signed URL only for `clean/`
    objects owned by the caller. Public profile DTOs expose attachment metadata but never object
    keys, hashes, rejection details, or signed URLs.
  - Verify: the e2e spec runs against real Postgres, MinIO, and ClamAV and covers clean download,
    infected refusal, expired/foreign capability refusal, cross-user 404, quota, and soft delete.

## Phase 2 — profile API and public/editor UI

- [ ] **Expose strict owner and public profile APIs**
  - Files: `src/routes/api/self-managed/profile/index.ts`,
    `src/routes/api/self-managed/profile/$profileId.ts`,
    `src/routes/api/self-managed/handle/$handle/reserve.ts`,
    `src/routes/api/self-managed/visibility.ts`,
    `tests/unit/routes/api/self-managed-profile.test.ts`
  - Do: implement authenticated create/update/delete/visibility and a public handle lookup. Resolve
    identity on the server, use strict schemas, rate-limit creation/reservation/public lookup, return
    the same 404 for absent and unauthorized resources, and audit material visibility changes without
    logging profile content.
  - Verify: route tests cover 200/400/401/404/409/429, unknown fields, handle expiry, idempotent
    retries, draft/unlisted/public visibility, and cross-user enumeration resistance.

- [ ] **Build the editor and public profile with explicit provenance**
  - Files: `src/routes/_dashboard/me/profile.tsx`, `src/routes/u/$handle.tsx`,
    `src/modules/builder-profile/components/SelfManagedProfile.tsx`,
    `src/modules/builder-profile/components/AttachmentUploader.tsx`,
    `tests/e2e/self-managed-profile.spec.ts`
  - Do: build an accessible owner editor and SSR public page. Render a distinct neutral
    `Self-managed` chip on every self-declared block and never the verified badge. Only clean
    attachments appear publicly; unlisted resolves by direct URL with `noindex`; draft/deleted is
    404. Reuse builder-profile primitives where their semantics match.
  - Verify: Playwright creates, edits, uploads, publishes, refreshes, and visits the profile as an
    anonymous browser; axe is clean; draft is 404; unlisted is `noindex`; the verified visual token
    never appears until an actual verified claim is linked.

## Phase 3 — unified discovery without duplicated source logic

- [ ] **Add self-managed as a typed internal search origin**
  - Files: `src/lib/sources/types.ts`, `src/lib/sources/self-managed.ts`,
    `src/lib/search.ts`, `src/lib/dedup.ts`, `src/shared/lib/profile-suppression.ts`,
    `tests/unit/lib/search/self-managed.test.ts`
  - Do: add the `self-managed` origin exhaustively to every `SourceName`-keyed registry or introduce
    a separate typed internal-origin union if that avoids pretending it is a network connector.
    Query only public, non-deleted profiles. Preserve source health semantics, use stable
    `(source, sourceId)` identity, never merge by display name/handle, and apply suppression before
    ranking. The registry currently has 15 historical source identifiers but only 13 active network
    connectors; tests must not call the internal origin over HTTP.
  - Verify: `pnpm type-check` catches every exhaustive registry; unit tests prove inclusion,
    exclusion, dedup, suppression, timeout/error reporting, and unchanged relative order for
    pre-existing results.

- [ ] **Index public self-managed profiles for semantic search**
  - Files: `src/lib/semantic/index-writer.ts`,
    `src/shared/lib/repositories/public-builder-embeddings.ts`,
    `src/shared/lib/operational-schedules.ts`,
    `src/routes/api/admin/self-managed/run-worker.ts`,
    `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`
  - Do: write a distinct entity kind for self-managed people using bio/headline/topics/services and
    clean attachment descriptions only. Enqueue refresh on material publish/update/clean-scan events
    and register a bounded reconciliation worker with a unique `jobKey` and `withJobRun`. Deletion or
    restriction removes the semantic row immediately.
  - Verify: repository tests prove entity-kind filtering and deletion; worker test proves bounded,
    idempotent reconciliation; semantic API e2e returns a public fixture and excludes draft/deleted.

- [ ] **Apply the shared inclusion policy to every current matching surface**
  - Files: `src/shared/lib/self-managed/inclusion-policy.ts`,
    `src/routes/api/recommendations/index.ts`, `src/lib/sprints/results.ts`,
    `src/lib/alerts/worker.ts`, `src/lib/solutions/`,
    `tests/unit/shared/lib/self-managed/inclusion-policy.test.ts`,
    `tests/e2e/self-managed-profile.spec.ts`
  - Do: centralize eligibility (public, non-deleted, non-suppressed), provenance decoration and the
    explicit opt-out. Recommendations, sprint shortlists, alerts, and solution-person results call
    the policy rather than duplicating filters. Opt-out changes inclusion only, never permissions or
    the rank of non-self-managed rows. Do not invent a global preference JSON blob; use the typed
    `user_preferences` contract from plan 02 or a per-resource field when the choice belongs to a
    sprint.
  - Verify: unit matrix covers default-on, explicit-off, deleted, suppressed, draft, unlisted and
    rank preservation; e2e asserts the chip on search, recommendations and sprint results.

- [ ] **Guard future matching surfaces mechanically**
  - Files: `scripts/check-self-managed-coverage.mjs`, `package.json`,
    `plans/_meta/conventions.md`
  - Do: add a repo-shape gate whose allowlist enumerates every route/worker that emits people or
    candidate matches and records its inclusion-policy call or explicit non-person exemption. Wire
    the script into `pnpm ci:local`; a new matching surface without a declaration must fail.
  - Verify: the script passes, then fails when a scratch matching route is added without a
    declaration, and passes again after the scratch file is removed.

## Phase 4 — promotion, privacy, lifecycle, and rollout

- [ ] **Implement reversible promotion to a verified claim**
  - Files: `src/shared/lib/repositories/self-managed-profiles.ts`,
    `src/shared/lib/human-identity/link-policy.ts`,
    `src/routes/api/self-managed/profile/$profileId/promote.ts`,
    `tests/unit/security/self-managed-promotion.test.ts`
  - Do: require an already verified claim and explicit owner confirmation; link by immutable ids,
    preserve the self-managed narrative/attachments, make the verified claim authoritative for
    verified fields, and keep unlink/relink auditable. Similarity or matching handles never
    auto-promote.
  - Verify: tests cover verified/unverified claim, wrong owner, conflicting link, unlink/relink,
    retained attachments and no automatic link from a high similarity score.

- [ ] **Extend data export, erasure, suppression, and retention**
  - Files: `src/shared/lib/repositories/account-privacy.ts`,
    `src/shared/lib/repositories/profile-removal.ts`,
    `src/routes/api/me/data-export/index.ts`,
    `tests/unit/shared/lib/repositories/account-privacy.test.ts`,
    `tests/e2e/api/privacy-profile-removal.spec.ts`
  - Do: include profile/attachment metadata in the existing export without object keys or signed
    URLs; immediately tombstone public/search reads on erasure; purge blobs in bounded idempotent
    batches after 30 days; retain only the minimal audit record required by policy.
  - Verify: export fixture contains declared content and no storage secret; an erasure e2e removes
    profile/search visibility immediately and a retention test seeded beyond one batch deletes every
    eligible blob while preserving active ones.

- [ ] **Integrate onboarding, dashboard, landing, and truthful analytics**
  - Files: `src/routes/onboarding/building.tsx`,
    `src/modules/dashboard/lib/dashboard-presets.ts`,
    `src/modules/landing/content/segment-pages.ts`,
    `src/shared/lib/conversion-events.ts`,
    `tests/e2e/self-managed-profile.spec.ts`
  - Do: branch `building` between claim-existing and create-from-scratch, add real profile status to
    the building dashboard preset, and make `/for/builders` promise only shipped behavior. Events use
    allowlisted ids/statuses and never profile text, filenames, handles, or attachment metadata.
  - Verify: e2e covers landing → signup → building onboarding → editor → public profile and
    an existing-claim path; analytics assertions prove no PII enters event payloads.

- [ ] **Ship behind a fail-closed flag and record runtime evidence**
  - Files: `.env.example`, `docs/operations/self-managed-profiles-rollout.md`,
    `content/changelog/self-managed-profiles.md`
  - Do: add one server-owned feature flag that returns 404/disabled UI when off, document migration,
    worker, storage, rollback and observability checks, and prepare truthful changelog copy. Rollback
    disables create/update/indexing while preserving existing data and erasure access.
  - Verify: `pnpm ci:local` is green; the complete Playwright flow passes against real Postgres,
    MinIO and ClamAV with flag on; flag off hides entry points and blocks writes while data export and
    erasure remain available; runtime evidence is linked from the rollout document.
