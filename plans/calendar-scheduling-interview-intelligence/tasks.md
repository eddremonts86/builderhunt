# Tasks: Calendar, Scheduling, and Interview Intelligence

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/spec.md) and
> [`ai-expansion`](../ai-expansion/spec.md)
> **Blocks**: nothing
> **Reality check**: every task below is new work unless it explicitly says `extend`. Reuse tenant
> principal/context, repositories, AI task registry, rate limiting, Resend, audit, entitlements,
> worker-role, migration integrity, and dashboard shell. Do not import the global database into a
> tenant repository or route. Generate migrations from the current journal; do not renumber or edit
> unrelated pending migrations.

## Phase 0 — Prerequisites and configuration

- [ ] **Complete the canonical tenant/RLS release gate**
  - Files: `plans/security-and-multitenancy/tasks.md`, `.env.example`, `.env.production.example`,
    `docs/operations/tenant-cutover.md`
  - Do: Finish the plan's remaining canonical read/write, non-null tenant, runtime-role, RLS,
    production-evidence, and restore gates before adding candidate private data. Record the verified
    migration and runtime-role state in that plan; do not mark this task complete from unit tests.
  - Verify: `pnpm security:boundaries && pnpm test:migrations:local && pnpm test:rls:local`; production
    cutover evidence satisfies the existing plan.

- [ ] **Create provider accounts and approve data controls**
  - Files: `docs/operations/interview-provider-register.md` (new),
    `docs/architecture/data-classification.md`, `docs/architecture/threat-model.md`
  - Do: Record Cloudflare R2 EU jurisdiction, Deepgram EU endpoint, Azure regional EU deployment,
    Stripe test/live account separation, DPA links/status, retention, training opt-out, deletion,
    subprocessors, region, account owner, and annual review date. Complete a DPIA before production
    voice enablement. Store no secret values.
  - Verify: security/privacy reviewer signs the register; each regional endpoint is confirmed from a
    test response/console and every provider can be disabled independently.

- [ ] **Add environment schema and kill switches**
  - Files: `src/shared/lib/env.ts`, `src/shared/lib/env.security.test.ts`, `.env.example`,
    `.env.production.example`
  - Do: Add server-only R2 endpoint/account/bucket/access keys/jurisdiction, ClamAV host/port,
    Deepgram key/EU base URL, Azure endpoint/key/deployment/API version, Stripe secret/webhook/price
    IDs, retention days, credit pack configuration, and the eight release flags from `plan.md`.
    Production validation must require regional URLs when a sensitive flag is enabled and reject
    secrets prefixed with `VITE_`.
  - Verify: env tests cover disabled minimal config, each enabled dependency, non-EU rejection,
    missing secret, malformed retention/price values, and public-secret leakage; `pnpm test
src/shared/lib/env.security.test.ts`.

- [ ] **Install and lock reviewed dependencies**
  - Files: `package.json`, `package-lock.json`
  - Do: Add FullCalendar Standard React/day-grid/time-grid/list/interaction/RRule packages, `rrule`,
    `@js-temporal/polyfill`, AWS S3 client/presigner, `file-type`, `pdfjs-dist`, `mammoth`,
    `ical-generator`, `openai`, and `stripe`. Record accepted MIT/Apache/BSD licenses; do not install
    FullCalendar Premium or an unmaintained ClamAV wrapper.
  - Verify: `pnpm list --depth 0` has no invalid tree; `pnpm build`,
    `pnpm security:dependencies`, and a license report show no unapproved runtime license.

- [ ] **Define shared feature/catalog configuration**
  - Files: `src/shared/lib/interview-config.ts` (new),
    `src/shared/lib/interview-config.test.ts` (new)
  - Do: Define supported MIME/extensions, 10 MB/25 MB limits, retention defaults, supported capture
    modes/languages, 5/1-minute/5 credit costs, 140 included Pro credits, top-up packs, low-balance
    thresholds, recurrence horizon, and safe public flag DTO. Validate all operator overrides.
  - Verify: tests reject negative/zero limits, inconsistent pack pricing, unsupported jurisdiction,
    excessive retention, and missing fallback; `pnpm test src/shared/lib/interview-config.test.ts`.

## Phase 1 — Pure domain contracts

- [ ] **Implement calendar contracts and state machine**
  - Files: `src/shared/lib/calendar.ts` (new), `src/shared/lib/calendar.test.ts` (new)
  - Do: Add event/occurrence/participant/feed DTO schemas, event types/statuses, source types,
    visibility fixed to `private`, optimistic-version input, transition guard, half-open range
    overlap helper, and explicit read-only projection discrimination.
  - Verify: tests cover every valid/invalid transition, invalid ranges, stale version mapping,
    participant DTO minimization, and projection `editable: false`; `pnpm test
src/shared/lib/calendar.test.ts`.

- [ ] **Implement timezone, recurrence, and availability calculations**
  - Files: `src/shared/lib/scheduling.ts` (new), `src/shared/lib/scheduling.test.ts` (new)
  - Do: Add availability/override/invitation/slot schemas, IANA timezone validation, Temporal-based
    local-to-instant conversion, RFC 5545/RRule expansion contract, exception dates, buffers,
    minimum notice/horizon, busy-range subtraction, deterministic slot IDs, and safe public errors.
  - Verify: fixtures cover Copenhagen spring-forward/fall-back, UTC, America/New_York, half-hour
    offsets, overnight invalid rules, recurrence exclusions, buffer collisions, no availability,
    and deterministic ordering; `pnpm test src/shared/lib/scheduling.test.ts`.

- [ ] **Implement interview schemas and prohibited-output validation**
  - Files: `src/shared/lib/interviews.ts` (new), `src/shared/lib/interviews.test.ts` (new)
  - Do: Add document/session/segment/suggestion/report/consent schemas, all state transitions,
    speaker estimate/mapping, evidence reference integrity, source manifest, capture capability
    states, and rejection of score/rank/personality/emotion/culture-fit/hire-reject fields or text.
  - Verify: tests cover all transitions, dangling evidence, duplicate segment IDs/sequences,
    prohibited outputs, unknown speaker, correction audit, and deterministic manual templates;
    `pnpm test src/shared/lib/interviews.test.ts`.

- [ ] **Implement immutable credit arithmetic**
  - Files: `src/shared/lib/usage-credits.ts` (new),
    `src/shared/lib/usage-credits.test.ts` (new)
  - Do: Define grant/reservation/ledger/provider-usage schemas and pure reserve, extend, consume,
    settle, release, refund, expiry, balance, low-credit, and reconciliation calculations using
    integer credits/currency minor units only.
  - Verify: property-style tests prove conservation, non-negative balances, idempotent replay,
    partial settlement/refund, expiry priority, rounding of provider-billed seconds, and <1%
    reconciliation math; `pnpm test src/shared/lib/usage-credits.test.ts`.

- [ ] **Define provider interfaces without SDK leakage**
  - Files: `src/lib/storage/types.ts` (new), `src/lib/interviews/transcription/types.ts` (new),
    `src/lib/interviews/sensitive-ai/types.ts` (new), `src/lib/payments/types.ts` (new)
  - Do: Define narrow interfaces for signed upload/download/delete/move, scan/extract, ephemeral
    transcription credentials/usage, structured sensitive completion, checkout/refund/customer
    portal, and webhook normalization. Domain layers receive normalized errors and usage, not vendor
    response types.
  - Verify: TypeScript fake adapters implement every interface without provider packages;
    `pnpm type-check`.

## Phase 2 — Calendar persistence and RLS

- [ ] **Add calendar and scheduling schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`, `docs/architecture/data-classification.md`
  - Do: Add `user_calendars`, `calendar_events`, `calendar_event_occurrences`,
    `event_participants`, `availability_rules`, `availability_overrides`,
    `scheduling_invitations`, `candidate_submissions`, and `candidate_links`. Use UUID PKs,
    `organization_id`, owner/creator columns, composite `(organization_id,id)` uniques/FKs,
    timestamptz instants, IANA timezone text, typed checks, event `version >= 1`, one default calendar
    partial unique, occurrence identity unique, and indexes for owner/range/status/expiry scans.
  - Verify: `pnpm db:generate`; inspect generated SQL for no unexplained drop/rewrite; `pnpm exec
drizzle-kit check && pnpm test:migrations:local`.

- [ ] **Add operational schedule and run schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`, `docs/architecture/data-classification.md`
  - Do: Add system-operational `operational_schedules` and `job_runs` with stable job key,
    cron/timezone, scope, enabled/next-run, scheduled/actual timestamps, state checks, counters,
    duration, redacted error code, and scan indexes. Grant only worker/platform writes and narrowly
    allow calendar projection reads through repository DTOs.
  - Verify: migration checks pass; direct web-role insert/update fails; worker insert and redacted
    projection select pass in local PostgreSQL.

- [ ] **Add strict private-user RLS policies**
  - Files: `drizzle/`, `src/shared/lib/security/rls-policy.test.ts`,
    `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/verify-rls-local.mjs`
  - Do: Enable/force RLS on every new tenant table. Calendar/availability/invitation owner can
    access; explicitly participating internal users get only resource-permitted read; org admin
    without participation is denied. Public capability never receives database role access.
    Workers receive scoped policies for occurrence/job/retention work.
  - Verify: direct SQL covers owner, participant, unrelated member, admin without participation,
    tenant B, missing context, spoofed context, cross-tenant FK, and worker scope; `pnpm
test:rls:local`.

- [ ] **Implement calendar repository**
  - Files: `src/shared/lib/repositories/calendar.ts` (new),
    `src/shared/lib/repositories/calendar.test.ts` (new)
  - Do: Add calendar/event/occurrence/participant CRUD and range queries using an injected
    `TenantTransaction`; explicit DTO columns only; all predicates include server-resolved
    organization and owner/participant semantics; optimistic updates match `id+organization+version`.
  - Verify: repository tests cover tenant predicates, no unrestricted row serialization, stale
    update, occurrence upsert, participant access, and admin denial; `pnpm test
src/shared/lib/repositories/calendar.test.ts`.

- [ ] **Implement scheduling repository**
  - Files: `src/shared/lib/repositories/scheduling.ts` (new),
    `src/shared/lib/repositories/scheduling.test.ts` (new)
  - Do: Add availability/override/invitation/submission/link methods, hashed-capability lookup,
    generic public DTOs, expiry/revocation mutation, and transaction operations needed for atomic
    booking. Never return token hash or organization ID publicly.
  - Verify: tests cover tenant scope, capability hash lookup, expired/revoked/used tokens,
    non-enumerating misses, and cross-invitation mutation denial; `pnpm test
src/shared/lib/repositories/scheduling.test.ts`.

## Phase 3 — Calendar service, API, worker, and UI

- [ ] **Implement calendar service and authorization**
  - Files: `src/lib/calendar/service.ts` (new), `src/lib/calendar/service.test.ts` (new),
    `src/shared/lib/authorization/permissions.ts`,
    `src/shared/lib/authorization/permissions.test.ts`
  - Do: Orchestrate create/update/move/resize/cancel/delete/range operations through tenant context;
    centralize owner/participant permissions; enforce start/end, private visibility, recurrence,
    version, and event-source mutation rules.
  - Verify: service tests cover every role/action, stale membership, stale version, recurrence edit
    scope, cancel vs delete, and no admin implicit access; targeted tests pass.

- [ ] **Implement recurrence materialization worker**
  - Files: `src/lib/calendar/recurrence-worker.ts` (new),
    `src/lib/calendar/recurrence-worker.test.ts` (new),
    `src/shared/lib/repositories/calendar-worker.ts` (new),
    `src/routes/api/admin/calendar/run-worker.ts` (new)
  - Do: Expand recurring events idempotently for the configured past/future horizon, apply
    exclusions/overrides/cancellations, prune obsolete future instances, lease batches by tenant,
    write job runs, and authenticate like existing workers using worker scope rather than a global
    tenant transaction.
  - Verify: repeated/concurrent runs produce identical occurrence sets; one tenant failure does not
    affect another; unauthorized route fails; run against local DB and inspect rows.

- [ ] **Add calendar event APIs**
  - Files: `src/routes/api/calendar/events/index.ts` (new),
    `src/routes/api/calendar/events/$eventId.ts` (new),
    `src/routes/api/calendar/events/$eventId/cancel.ts` (new)
  - Do: Add authenticated range GET, create POST, detail GET, versioned PATCH, DELETE, and cancel
    POST using `requireTenantPrincipal`, tenant context, Zod request limits, CSRF protection, safe
    errors, explicit DTOs, and audit events for mutations/sharing.
  - Verify: API tests/curl cover 401, no active org, malformed range, owner success, participant
    read-only, admin denial, tenant B, stale version `409`, and redacted errors.

- [ ] **Add availability APIs**
  - Files: `src/routes/api/calendar/availability/index.ts` (new),
    `src/routes/api/calendar/availability/overrides.ts` (new)
  - Do: Add GET/PUT weekly rules and POST/DELETE overrides for the authenticated owner, bounded
    effective ranges, timezone validation, overlap normalization, versioning, and cache invalidation.
  - Verify: tests/curl cover timezone/DST inputs, overlapping rules, invalid overnight interval,
    tenant B, stale version, and normalized response.

- [ ] **Build calendar feature components**
  - Files: `src/modules/calendar/components/CalendarPage.tsx` (new),
    `src/modules/calendar/components/CalendarView.tsx` (new),
    `src/modules/calendar/components/EventEditor.tsx` (new),
    `src/modules/calendar/components/EventDetails.tsx` (new),
    `src/modules/calendar/components/AvailabilityEditor.tsx` (new),
    `src/modules/calendar/components/CalendarAgenda.tsx` (new)
  - Do: Add responsive FullCalendar month/week/day/list views, range fetching, optimistic drag/resize
    with rollback, editor/detail side panel, recurrence scope selection, timezone label, agenda
    fallback, keyboard actions, visible focus, loading/empty/error/stale states, and no color-only
    semantics.
  - Verify: component tests cover keyboard and mutation rollback; Playwright creates/moves/recurs/
    cancels an event at desktop and 320 px; axe scan has no critical violations.

- [ ] **Add calendar route and navigation**
  - Files: `src/routes/_dashboard/calendar/index.tsx` (new),
    `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `src/routeTree.gen.ts`
  - Do: Add `/calendar`, lazy-load heavy calendar UI, add Calendar navigation icon/active state,
    preserve route range/view in safe search params, and regenerate route tree through the normal
    router plugin/build process rather than hand-maintaining it.
  - Verify: `pnpm build`; authenticated navigation loads calendar, direct URL restores view/range,
    signed-out request redirects, and mobile nav remains usable.

## Phase 4 — Operational projections

- [ ] **Implement schedule registry and next-run calculation**
  - Files: `src/shared/lib/operational-schedules.ts` (new),
    `src/shared/lib/operational-schedules.test.ts` (new),
    `src/shared/lib/repositories/platform-operations.ts`
  - Do: Register stable keys/cadences/timezones/labels/source routes for current alert, sprint,
    enrichment, discovery, embeddings, legal, calendar, document, retention, and reconciliation
    workers; calculate next runs deterministically and upsert registry state.
  - Verify: tests cover DST, disabled schedule, next-run boundary, duplicate key, and safe route;
    registry sync twice is idempotent.

- [ ] **Write job-run records from every worker entry point**
  - Files: `src/routes/api/admin/alerts/run-worker.ts`,
    `src/routes/api/admin/discovery/run-worker.ts`,
    `src/routes/api/admin/embeddings/run-worker.ts`,
    `src/routes/api/admin/enrichment/run-worker.ts`,
    `src/routes/api/admin/legal/run-worker.ts`,
    `src/routes/api/admin/sprints/run-worker.ts`,
    `src/shared/lib/repositories/platform-operations.ts`,
    `src/shared/lib/repositories/platform-operations.test.ts`
  - Do: Wrap each run in a shared start/finish/fail recorder using stable idempotency per scheduled
    occurrence, counters and redacted error codes; never store payload/candidate content.
  - Verify: success/failure/retry tests produce one monotonic run row and no raw error secrets;
    execute at least two real local workers and inspect API projection DTOs.

- [ ] **Persist honest alert evaluation timing**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`,
    `src/shared/lib/repositories/organization-alerts.ts`,
    `src/shared/lib/repositories/alerts-worker.ts`, `src/lib/alerts/worker.ts`,
    `src/shared/lib/alerts.test.ts`
  - Do: Add/normalize `next_evaluation_at`, cadence, pause state, and last evaluated timestamp for
    alerts so calendar estimates come from source state. Update worker atomically on success/failure;
    do not promise a match.
  - Verify: migration and alert tests cover active/paused/failure/retry cadence; existing alert UI
    remains correct.

- [ ] **Implement unified calendar feed**
  - Files: `src/lib/calendar/projections.ts` (new),
    `src/lib/calendar/projections.test.ts` (new),
    `src/routes/api/calendar/feed.ts` (new)
  - Do: Merge authorized internal events, operational next runs, alert estimates, job runs, and
    existing alert triggers over a bounded range; preserve discriminated DTOs, `estimated|actual`,
    `editable: false`, stale timestamps, and source links; paginate agenda results.
  - Verify: tests cover layer filters, range boundaries, stale source, no irrelevant tenant job,
    read-only fields, and query-count ceiling; p95 local fixture query under 500 ms.

- [ ] **Add calendar layer UI**
  - Files: `src/modules/calendar/components/CalendarLayers.tsx` (new),
    `src/modules/calendar/components/ProjectionDetails.tsx` (new),
    `src/modules/calendar/components/CalendarPage.tsx`
  - Do: Add independent appointment/job/alert/result toggles, shape+label distinctions,
    estimate/stale badges, read-only detail, source navigation, and persisted user display preference.
  - Verify: Playwright toggles each layer, proves projections cannot drag/edit, follows source link,
    and calendar remains usable when feed projections fail.

## Phase 5 — Invitation and atomic booking

- [ ] **Implement capability exchange and session validation**
  - Files: `src/lib/scheduling/capability.ts` (new),
    `src/lib/scheduling/capability.test.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/session.ts` (new),
    `src/shared/lib/security/headers.ts`, `src/shared/lib/security/headers.test.ts`
  - Do: Generate/hash 256-bit secrets, validate constant-time, exchange fragment token once for
    invitation-scoped secure cookie, bind expiry/revocation, replace client history, apply no-referrer
    and strict public scheduling CSP, and implement safe replay/rotation behavior.
  - Verify: tests cover valid, wrong, expired, revoked, replayed, timing-safe mismatch, cookie flags,
    token absent from logs/referrer/history, and non-enumerating responses.

- [ ] **Implement invitation service**
  - Files: `src/lib/scheduling/invitation-service.ts` (new),
    `src/lib/scheduling/invitation-service.test.ts` (new),
    `src/shared/lib/security/audit.ts`
  - Do: Create/preview/send/open/decline/revoke/expire transitions, optional builder identity link,
    role context snapshot, policy validation, one active capability, audit, and outbox-safe send.
  - Verify: service tests cover every transition, owner/participant/admin permissions, duplicate
    send, stale builder, expiry, and redacted audit details.

- [ ] **Implement slot-query service**
  - Files: `src/lib/scheduling/slot-service.ts` (new),
    `src/lib/scheduling/slot-service.test.ts` (new)
  - Do: Load invitation policy, rules, overrides, busy occurrences, and booked appointments; derive
    bounded opaque slots in requested timezone; cache only keyed by organization/owner/invitation/
    version/range; invalidate on relevant mutation.
  - Verify: tests cover DST, buffers, notice, horizon, recurrence, cancellation, reschedule, cache
    key/invalidation, and no conflict-source leakage; benchmark fixture under 750 ms p95.

- [ ] **Implement atomic booking, cancellation, and rescheduling**
  - Files: `src/lib/scheduling/booking-service.ts` (new),
    `src/lib/scheduling/booking-service.test.ts` (new),
    `src/shared/lib/repositories/scheduling.ts`
  - Do: Acquire transaction advisory lock by organizer/date, recompute slot, create event and
    participants, mark invite booked, create outbox messages, and commit together. Cancellation
    preserves history. Reschedule creates linked replacement occurrence/event state without a gap or
    double confirmation.
  - Verify: real PostgreSQL race test yields exactly one booking; rollback leaves no partial rows;
    stale/used/revoked/expired capability and invalid slot return safe errors.

- [ ] **Add authenticated invitation APIs**
  - Files: `src/routes/api/scheduling/invitations/index.ts` (new),
    `src/routes/api/scheduling/invitations/$invitationId.ts` (new),
    `src/routes/api/scheduling/invitations/$invitationId/send.ts` (new),
    `src/routes/api/scheduling/invitations/$invitationId/revoke.ts` (new)
  - Do: Add owner-only create/list/detail/update/send/revoke handlers with tenant context, CSRF,
    Zod limits, explicit DTOs, audit, feature/plan gates, and consistent errors.
  - Verify: API tests cover 401, tenant B, unrelated member/admin denial, builder from other tenant,
    plan disabled, repeated send/revoke, and DTO minimization.

- [ ] **Add public invitation and booking APIs**
  - Files: `src/routes/api/public/scheduling/$invitationId/index.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/slots.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/book.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/decline.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/cancel.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/reschedule.ts` (new)
  - Do: Validate invitation cookie plus CSRF, apply capability/IP rate limits, return public
    allowlists, accept normalized candidate details/slot ID, and expose only valid lifecycle actions.
  - Verify: API tests cover missing/expired/revoked cookie, CSRF, enumeration, rate limit, wrong
    invitation, book race `409`, and successful cancel/reschedule.

- [ ] **Add calendar invitation email and ICS generation**
  - Files: `src/shared/lib/email.ts`, `src/shared/lib/email.test.ts`,
    `src/lib/calendar/ics.ts` (new), `src/lib/calendar/ics.test.ts` (new)
  - Do: Add invitation/confirmation/reschedule/cancel/expiry templates; generate standards-compliant
    UID, DTSTART/DTEND/TZID, organizer/attendee, METHOD request/cancel, sequence, escaped text, and
    external meeting/location fields. Email links use fragment token and no tracking query.
  - Verify: snapshot/plain-text tests; parse emitted `.ics` with an independent parser; Resend dev
    fallback logs no token; real test inbox receives/open imports one event and cancellation.

- [ ] **Build organizer scheduling UI**
  - Files: `src/modules/scheduling/components/InvitationComposer.tsx` (new),
    `src/modules/scheduling/components/InvitationPreview.tsx` (new),
    `src/modules/scheduling/components/InvitationStatus.tsx` (new),
    `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: Add `Invite to interview`, role/duration/range/timezone/buffer/modality/message fields,
    preview/send confirmation, status/history/actions, validation, and disabled/plan-gated states.
  - Verify: component/Playwright tests create from tracked builder, preview candidate timezone,
    send, revoke, and show safe error without losing draft.

- [ ] **Build mobile accountless candidate portal**
  - Files: `src/routes/schedule/$invitationId.tsx` (new),
    `src/modules/scheduling/components/CandidatePortal.tsx` (new),
    `src/modules/scheduling/components/SlotPicker.tsx` (new),
    `src/modules/scheduling/components/CandidateDetailsForm.tsx` (new)
  - Do: Exchange fragment capability, show organizer/role/privacy/modality, timezone switcher, slot
    picker without drag/drop, candidate details, decline/book/cancel/reschedule states, expiry and
    conflict recovery, no analytics, and 320 px accessibility.
  - Verify: Playwright completes signed-out mobile booking, timezone switch, race recovery,
    cancellation/reschedule, expired/revoked link, keyboard-only flow, and axe scan.

## Phase 6 — Private documents and candidate intake

- [ ] **Add document, extraction, and consent schema/RLS**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`,
    `docs/architecture/data-classification.md`, `src/shared/lib/security/rls-policy.test.ts`
  - Do: Add `candidate_documents`, `document_extractions`, and `privacy_consents` with tenant
    composite FKs, generated-key uniqueness, checksum/bytes/type/status/error/expiry indexes and
    checks, versioned purpose, grant/withdraw timestamps, and owner/participant policies. Capability
    writes go through a narrowly privileged server command, never anonymous SQL grants.
  - Verify: migration/RLS tests cover owner, participant, admin denial, tenant B, cross-invitation
    FK, worker scan, and missing context.

- [ ] **Implement R2 EU private storage adapter**
  - Files: `src/lib/storage/r2.ts` (new), `src/lib/storage/r2.test.ts` (new),
    `src/lib/storage/private-object-storage.ts` (new)
  - Do: Implement generated quarantine/clean keys, short signed PUT/GET, required content length/
    type/checksum, HEAD verification, copy/move, delete, lifecycle prefix cleanup, EU endpoint
    assertion, normalized errors, timeouts, and no public bucket ACL.
  - Verify: unit contract tests with fake S3; integration against test R2/MinIO uploads, rejects
    tampered checksum, cannot list/public-read, expires URLs, moves clean, and deletes all variants.

- [ ] **Implement ClamAV streaming scanner**
  - Files: `src/lib/storage/clamav.ts` (new), `src/lib/storage/clamav.test.ts` (new),
    `docker-compose.yml`, `Dockerfile`, `docs/operations/interview-provider-register.md`
  - Do: Implement bounded TCP `INSTREAM` client with timeout/size guard and clean/infected/error
    normalization. Add pinned ClamAV service/healthcheck for local/production topology and document
    signature updates/RAM. Scanner unavailable must never mark a file clean.
  - Verify: fake protocol tests plus EICAR integration produces `infected`; clean fixture passes;
    timeout remains quarantined; container healthcheck reports ready.

- [ ] **Implement deterministic document validation and extraction**
  - Files: `src/lib/storage/document-validation.ts` (new),
    `src/lib/storage/document-validation.test.ts` (new),
    `src/lib/storage/document-extraction.ts` (new),
    `src/lib/storage/document-extraction.test.ts` (new)
  - Do: Validate extension, actual media type/magic bytes, bytes, checksum, invitation quota; extract
    clean PDF/DOCX/TXT into bounded normalized plain text with page/section map; reject encrypted,
    corrupt, unsupported, polyglot, decompression-bomb-like, or empty files; sanitize control chars.
  - Verify: fixture suite covers valid formats and every rejection; extraction has deterministic
    content hash/page references and never renders source HTML.

- [ ] **Implement document repository and worker**
  - Files: `src/shared/lib/repositories/interview-documents.ts` (new),
    `src/shared/lib/repositories/interview-documents.test.ts` (new),
    `src/lib/scheduling/document-worker.ts` (new),
    `src/lib/scheduling/document-worker.test.ts` (new),
    `src/routes/api/admin/documents/run-worker.ts` (new)
  - Do: Lease uploaded documents per tenant, mark scanning/extracting terminal states atomically,
    download quarantine stream, scan, move clean, extract, store text/map, delete rejected objects,
    retry transient failures with cap, and record redacted job run.
  - Verify: repeated/concurrent worker is idempotent; tenant failure isolation; infected never moves;
    transient retry and permanent failure behave; unauthorized worker route fails.

- [ ] **Add candidate upload, completion, consent, and download APIs**
  - Files: `src/routes/api/public/scheduling/$invitationId/uploads.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/uploads/$documentId/complete.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/consents.ts` (new),
    `src/routes/api/interviews/$interviewId/documents/$documentId/download.ts` (new)
  - Do: Issue quota-bound signed upload, validate completion metadata, record separate purpose
    consent, and issue authorized five-minute clean-download only to owner/participants. Apply CSRF,
    capability/IP rate limit, safe status DTO, and audit without filename/email/token.
  - Verify: tests cover quota, forged key/size/type/checksum, cross-invitation completion, pending/
    rejected download, admin denial, tenant B, URL expiry, consent version, and withdrawal.

- [ ] **Add candidate links and intake UI**
  - Files: `src/modules/scheduling/components/CandidateIntake.tsx` (new),
    `src/modules/scheduling/components/DocumentUploader.tsx` (new),
    `src/modules/scheduling/components/ConsentFields.tsx` (new),
    `src/modules/scheduling/components/CandidatePortal.tsx`
  - Do: Add LinkedIn/personal/other URL validation, notes, resumable status UI, PDF/DOCX/TXT limits,
    separate document/transcription consent, scan/extraction statuses, delete/retry, and no server
    fetch of links. Booking may finish while documents continue processing.
  - Verify: Playwright uploads valid and EICAR/fake-type/oversized fixtures, edits URLs, accepts one
    purpose but declines transcription, books, and sees correct processing/error state.

## Phase 7 — Stripe and usage credits

- [ ] **Add payment and credit schema/RLS**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`,
    `docs/architecture/data-classification.md`, `src/shared/lib/security/rls-policy.test.ts`
  - Do: Add `stripe_customers`, `stripe_subscriptions`, `stripe_events`, `usage_credit_grants`,
    `usage_credit_reservations`, `usage_ledger_entries`, and `provider_usage_records` with
    organization composite keys, unique provider/event/idempotency references, integer units/minor
    currency, monotonic status checks, expiry/reconciliation indexes, append-only ledger grants, and
    owner/admin payment policy. Web role cannot update/delete ledger entries.
  - Verify: migration/RLS tests cover tenant A/B, member vs admin, worker/platform roles, duplicate
    event/idempotency, negative constraints, and direct ledger mutation denial.

- [ ] **Implement usage credit repository and transactional service**
  - Files: `src/shared/lib/repositories/usage-credits.ts` (new),
    `src/shared/lib/repositories/usage-credits.test.ts` (new),
    `src/lib/payments/credit-service.ts` (new),
    `src/lib/payments/credit-service.test.ts` (new)
  - Do: Implement grant, FIFO expiry-aware balance, reserve, extend, partial consume, settle,
    release, refund, operator adjustment, provider usage attach, and history DTO in serializable/
    locked transactions. Require reason/actor/idempotency and prohibit negative balance.
  - Verify: real DB concurrency tests prove two reservations cannot overspend; replay is no-op;
    failure rollback preserves balance; ledger conservation query passes.

- [ ] **Implement Stripe adapter and catalog mapping**
  - Files: `src/lib/payments/stripe.ts` (new), `src/lib/payments/stripe.test.ts` (new),
    `src/shared/lib/billing-shared.ts`, `src/shared/lib/billing.test.ts`
  - Do: Map configured recurring/top-up price IDs to immutable internal catalog entries; create/reuse
    organization customer, subscription checkout, top-up checkout, portal session, refund, and
    normalized event verification. Never accept price, credits, organization, or success from the
    client.
  - Verify: Stripe test-clock/fixture tests cover catalog mismatch, forged price, duplicate customer,
    checkout metadata, signature failure, refund, and disabled billing.

- [ ] **Implement idempotent Stripe webhook processing**
  - Files: `src/routes/api/webhooks/stripe.ts` (new),
    `src/lib/payments/webhook-service.ts` (new),
    `src/lib/payments/webhook-service.test.ts` (new)
  - Do: Read raw body, verify signature, store event before processing, enforce monotonic
    subscription/payment/refund transitions, grant credits only from paid configured line items,
    handle duplicate/out-of-order/retry, update organization entitlement, and redact logs.
  - Verify: Stripe CLI sends checkout/subscription/failure/refund events; replay grants once;
    out-of-order events do not regress state; bad signature returns 400 without persistence.

- [ ] **Add billing/credit APIs**
  - Files: `src/routes/api/usage/credits.ts` (new),
    `src/routes/api/usage/top-ups/checkout.ts` (new),
    `src/routes/api/billing/subscription/checkout.ts` (new),
    `src/routes/api/billing/portal.ts` (new)
  - Do: Add authorized balance/history, owner/admin checkout/top-up/portal, CSRF, configured pack ID
    allowlist, rate limit, safe redirect origin, feature flag, and audit. Ordinary members can see
    balance only if product policy allows; they cannot pay or adjust.
  - Verify: API tests cover role matrix, tenant B, forged pack/redirect, duplicate request,
    Stripe-disabled state, and no secret/provider object in DTO.

- [ ] **Extend organization entitlements and product surfaces**
  - Files: `src/shared/lib/billing-shared.ts`,
    `src/shared/lib/repositories/entitlements.ts`,
    `src/routes/api/plans/me.ts`, `src/routes/_landing/pricing.tsx`,
    `src/routes/_dashboard/settings/billing.tsx`,
    `plans/pricing-and-billing/spec.md`, `plans/pricing-and-billing/plan.md`,
    `plans/pricing-and-billing/tasks.md`
  - Do: Add calendar/scheduling/interview gates and included credits to the organization catalog,
    expose enforced usage/balance, add subscription/top-up/history UI, remove the obsolete global
    no-processor claim, preserve existing manual records during migration, and ensure marketing
    matches server limits.
  - Verify: billing tests for free/pro/team, trial/past-due/canceled, downgrade, cached entitlement,
    and credit allowance; UI and API agree on price/features.

- [ ] **Implement credit warnings and optional capped auto-recharge**
  - Files: `src/lib/payments/auto-recharge.ts` (new),
    `src/lib/payments/auto-recharge.test.ts` (new),
    `src/modules/interviews/components/CreditBalance.tsx` (new),
    `src/routes/_dashboard/settings/billing.tsx`
  - Do: Add 80/90/ten-minute/zero warnings, explicit opt-in auto-recharge pack and monthly cap,
    idempotent trigger, payment failure disablement, and notification. Default is off; never create
    postpaid debt.
  - Verify: tests cover each threshold once, concurrent trigger, monthly cap, failed payment,
    opt-out, and no negative balance; test-mode charge grants once.

## Phase 8 — Sensitive AI and brief

- [ ] **Implement Azure regional sensitive AI adapter**
  - Files: `src/shared/lib/ai/azure.ts` (new), `src/shared/lib/ai/azure.test.ts` (new),
    `src/shared/lib/ai/sensitive.ts` (new), `src/shared/lib/ai/sensitive.test.ts` (new)
  - Do: Use Azure OpenAI regional endpoint/deployment with structured output, timeout, abort,
    bounded retry, no storage/training configuration, usage normalization, independent kill switch,
    redacted telemetry, and no MiniMax/local fallback. Reject non-regional configuration at runtime
    as defense in depth.
  - Verify: fake-server tests cover valid/invalid JSON, timeout, 429/5xx, abort, usage, disabled,
    non-EU endpoint, and logs without prompt/content; live smoke sends synthetic data only.

- [ ] **Register interview brief task**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: Add exact `interview-brief-generate` schemas from `spec.md`, server-only/no-cache metadata,
    evidence ID existence/refinement, untrusted wrapping, prohibited claims/language, bounded input/
    output, prompt version, and Pro/Team allowance. Route it through sensitive client selection.
  - Verify: task tests cover valid output, missing/dangling evidence, fabricated claim, prompt
    injection in CV, excessive arrays/text, cache null, free gate, and sensitive routing.

- [ ] **Add brief schema and repository**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`,
    `src/shared/lib/repositories/interviews.ts` (new),
    `src/shared/lib/repositories/interviews.test.ts` (new),
    `src/shared/lib/security/rls-policy.test.ts`
  - Do: Add `interview_briefs` with organization/event composite FK, owner, version/status, validated
    structured content/evidence manifest, provider/model/prompt version, expiry, editor, indexes, and
    private owner/explicit-participant RLS. Store no model prompt/response envelope.
  - Verify: migration/RLS/repository tests cover version uniqueness, owner/participant/admin denial,
    evidence shape, tenant B, and explicit DTO.

- [ ] **Implement brief generation/version service**
  - Files: `src/lib/interviews/brief-service.ts` (new),
    `src/lib/interviews/brief-service.test.ts` (new)
  - Do: Assemble role/profile/extraction evidence with stable IDs, reserve 5 credits, call sensitive
    task, validate evidence, save new draft version, settle/refund, support section regeneration and
    manual edits, and create deterministic fallback when disabled/failing.
  - Verify: tests cover ready/pending/rejected docs, no evidence, provider invalid/timeout, credit
    shortage, idempotent retry, fallback, edit/version conflict, settle and refund.

- [ ] **Add brief APIs and editor**
  - Files: `src/routes/api/interviews/$interviewId/brief/index.ts` (new),
    `src/routes/api/interviews/$interviewId/brief/$version.ts` (new),
    `src/routes/_dashboard/interviews/$interviewId/index.tsx` (new),
    `src/modules/interviews/components/InterviewBriefEditor.tsx` (new),
    `src/modules/interviews/components/EvidenceDrawer.tsx` (new)
  - Do: Add generate/read/version/edit/ready handlers and UI with evidence navigation, gaps,
    contradictions, question groups, section regeneration, credit estimate/confirmation, manual
    fallback, version conflict recovery, and owner/participant permissions.
  - Verify: API/component/Playwright tests generate from fixture CV, open every evidence link, edit,
    regenerate, handle insufficient credits/provider failure, and deny admin/tenant B.

## Phase 9 — Live interview persistence and transcription

- [ ] **Add live interview schema and RLS**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`,
    `docs/architecture/data-classification.md`, `src/shared/lib/security/rls-policy.test.ts`
  - Do: Add `interview_sessions`, `transcript_segments`, `interview_suggestions`, and
    `interview_reports` with tenant/event/session composite FKs, stable provider segment uniqueness,
    sequence/timestamp/confidence checks, speaker/correction columns, state/version/provider/prompt/
    expiry fields, evidence references, and strict owner/explicit-participant RLS. Add no audio/blob/
    storage-key column.
  - Verify: migration schema audit asserts no audio-like column; RLS tests cover owner, participant,
    admin denial, tenant B, worker retention, and cross-session evidence FK.

- [ ] **Implement Deepgram EU token and usage adapter**
  - Files: `src/lib/interviews/transcription/deepgram.ts` (new),
    `src/lib/interviews/transcription/deepgram.test.ts` (new)
  - Do: Create least-privilege short-lived browser credential/session configuration for EU streaming
    multilingual model, diarization, smart formatting, max speakers two, provider request ID and
    normalized termination duration. Never return master key or permit non-transcription endpoints.
  - Verify: fake/live synthetic tests cover EU URL, TTL/scope, master-key absence, invalid response,
    expiry, disconnect, final segment shape, diarization unknown, and usage duration.

- [ ] **Implement interview session service**
  - Files: `src/lib/interviews/session-service.ts` (new),
    `src/lib/interviews/session-service.test.ts` (new),
    `src/shared/lib/repositories/interviews.ts`
  - Do: Start/ready/live/pause/resume/finish/fail/abandon transitions, participant permission,
    versioned consent recheck, initial/live credit reservation and extension, heartbeat expiry,
    provider usage attach, final settlement, and redacted audit.
  - Verify: tests cover every transition, no consent, withdrawal, insufficient/expiring credit,
    participant/admin roles, stale heartbeat, provider failure, retry, and reservation lifecycle.

- [ ] **Add session/token/segment APIs**
  - Files: `src/routes/api/interviews/$interviewId/session.ts` (new),
    `src/routes/api/interviews/$interviewId/transcription-token.ts` (new),
    `src/routes/api/interviews/$interviewId/segments.ts` (new)
  - Do: Add authenticated create/transition/heartbeat/token and bounded final-segment batch handlers
    with session/participant/consent/credit/flag checks, stable idempotency, monotonic sequences,
    rate limits, CSRF, explicit DTOs, and no audio content type/body accepted.
  - Verify: API tests cover 401, tenant B, admin denial, no consent/credit, duplicate/reordered/
    oversized segments, audio MIME/body rejection, token TTL, paused/finished session, and exactly-once
    persistence.

- [ ] **Implement IndexedDB final-text outbox**
  - Files: `src/modules/interviews/lib/transcript-outbox.ts` (new),
    `src/modules/interviews/lib/transcript-outbox.test.ts` (new)
  - Do: Store only unacknowledged final text segments keyed by session/user, encrypt where supported
    or minimize to required fields, retry idempotently, delete on acknowledgement/logout/finish/
    expiry, and expose a cleanup marker for retention on next visit. Never store audio/interim text.
  - Verify: browser tests cover refresh/offline/reconnect, duplicate ack, cross-user separation,
    expiry/logout cleanup, storage quota error, and absence of audio/interim payload.

- [ ] **Implement browser capture and Web Audio mixer**
  - Files: `src/modules/interviews/lib/audio-capture.ts` (new),
    `src/modules/interviews/lib/audio-capture.test.ts` (new),
    `src/modules/interviews/lib/deepgram-client.ts` (new),
    `src/modules/interviews/lib/deepgram-client.test.ts` (new)
  - Do: Implement microphone preflight, optional display-audio request, track-capability state,
    Web Audio mixing, provider WebSocket, interim/final parsing, reconnect, device change, and
    guaranteed track/context/socket cleanup. Do not import/use `MediaRecorder` or construct audio
    Blob/object URL.
  - Verify: mocked media/WebSocket tests cover all capability states, permission denial, track end,
    reconnect, page unload, pause/stop, and static assertion forbidding `MediaRecorder`/audio Blob;
    manual Chrome preflight confirms devices.

- [ ] **Build dedicated live interview workspace**
  - Files: `src/routes/_dashboard/interviews/$interviewId/live.tsx` (new),
    `src/modules/interviews/components/LiveInterviewPage.tsx` (new),
    `src/modules/interviews/components/CapturePreflight.tsx` (new),
    `src/modules/interviews/components/LiveTranscript.tsx` (new),
    `src/modules/interviews/components/InterviewNotes.tsx` (new),
    `src/modules/interviews/components/InterviewControls.tsx` (new),
    `src/modules/interviews/components/SpeakerMapper.tsx` (new)
  - Do: Add brief sidebar, consent/capture banner, preflight, timer, live transcript, speaker
    correction, markers, private notes, pause/reconnect/finish, remaining credits, manual-only mode,
    screen-reader throttled announcements, reduced motion, and 320 px layout. Require explicit
    continuation in microphone-only remote mode.
  - Verify: component/Playwright with fake provider covers permissions, both capture modes,
    microphone-only confirmation, interim/final rendering, correction, offline outbox, pause,
    withdrawal, zero credit, finish, keyboard, and axe.

- [ ] **Run real browser capture beta verification**
  - Files: `docs/operations/interview-runtime-verification.md` (new)
  - Do: Test supported Chrome on macOS/Windows using in-person microphone and external Meet/Zoom
    tab/window audio, headphones/speakers/external mic, Spanish/English, noise and crosstalk. Record
    capability—not candidate content—latency, loss, diarization corrections, cleanup, and failures.
    Document Safari/Firefox degradation.
  - Verify: two consented/synthetic 30-minute sessions finish/reconnect with 99.9% acknowledged final
    segments, correct billing variance, and DevTools/storage/network inspection showing no audio
    artifact.

## Phase 10 — Contextual questions and reports

- [ ] **Register follow-up and report AI tasks**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: Add `interview-followup-suggest` and `interview-report-generate` exact schemas, server-only/
    no-cache/sensitive routing, bounded transcript windows, evidence validation, prohibited-output
    refinement, prompt versions, allowance/cost behavior, and deterministic templates.
  - Verify: tests cover prompt injection in transcript, dangling evidence, scoring/hire language,
    excessive output, 30-second throttle metadata, no cache, free gate, and sensitive route.

- [ ] **Implement topic window and suggestion service**
  - Files: `src/lib/interviews/suggestion-service.ts` (new),
    `src/lib/interviews/suggestion-service.test.ts` (new)
  - Do: Derive covered/pending topics, select bounded recent final segments, debounce/rate-limit per
    session, call sensitive task while paid live session is active, save only explicit use/save/
    dismiss actions, and degrade silently to prepared questions.
  - Verify: tests cover throttle, no new context, paused/manual/free state, provider failure,
    evidence references, ephemeral unsaved output, and concurrent request dedupe.

- [ ] **Implement report generation and finalization service**
  - Files: `src/lib/interviews/report-service.ts` (new),
    `src/lib/interviews/report-service.test.ts` (new),
    `src/shared/lib/repositories/interviews.ts`
  - Do: On finish, reserve 5 credits, load final segments/notes, generate or template report,
    validate evidence/prohibited content, save versioned review state, allow edits, prevent unresolved
    references, finalize with optimistic version, and settle/refund.
  - Verify: tests cover empty/partial transcript, provider failure, insufficient credit, invalid
    evidence, prohibited output, edit conflict, finalize, retry idempotency, settle/refund.

- [ ] **Add suggestion/report APIs**
  - Files: `src/routes/api/interviews/$interviewId/suggestions.ts` (new),
    `src/routes/api/interviews/$interviewId/report.ts` (new),
    `src/routes/api/interviews/$interviewId/finalize.ts` (new)
  - Do: Add authorized bounded suggestion generation/action and report read/edit/generate/finalize
    handlers with CSRF, rate/credit/flag gates, explicit DTOs, version checks, and safe errors.
  - Verify: API tests cover paused/finished state, throttle, tenant B, admin denial, forged evidence,
    stale version, insufficient credit, provider disabled, and successful finalization.

- [ ] **Build contextual question and report UI**
  - Files: `src/modules/interviews/components/ContextualQuestions.tsx` (new),
    `src/modules/interviews/components/InterviewReportEditor.tsx` (new),
    `src/modules/interviews/components/TranscriptEvidence.tsx` (new),
    `src/modules/interviews/components/LiveInterviewPage.tsx`,
    `src/routes/_dashboard/interviews/$interviewId/index.tsx`
  - Do: Show at most three contextual questions, rationale/evidence, use/save/dismiss, pending topics,
    processing state, report sections, transcript timestamp links, unsupported evidence resolution,
    manual fallback, credit confirmation, version conflict, and finalize confirmation.
  - Verify: Playwright completes live suggestion to final report, follows timestamp evidence, handles
    provider/credit failure, edits/finalizes, and confirms no score/recommendation UI.

## Phase 11 — Retention, privacy, reconciliation, and operations

- [ ] **Implement retention and reservation cleanup worker**
  - Files: `src/lib/interviews/retention-worker.ts` (new),
    `src/lib/interviews/retention-worker.test.ts` (new),
    `src/shared/lib/repositories/interview-retention.ts` (new),
    `src/routes/api/admin/interviews/run-retention.ts` (new)
  - Do: Lease expired resources per tenant, delete R2/provider/cache artifacts, then relational data
    in safe dependency order, expire/release stale reservations, retain minimal consent/audit per
    policy, retry partial failures, dry-run metrics, and write redacted job run.
  - Verify: seeded 90/180-day boundaries, shorter org override, R2/provider failure/retry,
    idempotency, tenant isolation, and unauthorized route; local runtime confirms objects/rows gone.

- [ ] **Extend privacy export and deletion**
  - Files: `src/shared/lib/repositories/account-privacy.ts`,
    `src/shared/lib/repositories/account-privacy.test.ts`,
    `src/routes/api/me/data-export/index.ts`,
    `src/routes/api/me/delete-account/index.ts`,
    `src/routes/_dashboard/settings/privacy.tsx`
  - Do: Include owned/participating calendar, invitations, submissions, links, documents metadata,
    extraction/brief/transcript/report/consent, and credit history in authorized export with private
    file links handled safely; delete/anonymize according to ownership/participant and organization
    lifecycle; add interview retention controls/status UI.
  - Verify: export fixture contains only subject-authorized data/no secrets/object keys; deletion
    removes storage/provider/cache artifacts; cross-user participant data follows documented policy;
    existing privacy tests remain green.

- [ ] **Update legal notices and consent copy**
  - Files: `src/routes/_landing/legal/privacy.tsx`,
    `src/routes/_landing/legal/terms.tsx`, `src/shared/lib/legal.ts`,
    `src/shared/lib/legal.test.ts`, `docs/operations/interview-provider-register.md`
  - Do: After legal review, describe document processing, transient audio capture, stored transcript,
    sensitive AI, purposes, legal basis, processors/regions, retention, rights, refusal/withdrawal,
    no training, no automated decision, and credit billing. Version consent text and preserve old
    versions.
  - Verify: legal snapshot/version tests pass; portal links exact notice version; withdrawal and
    contact paths work; reviewer sign-off recorded.

- [ ] **Implement provider usage reconciliation**
  - Files: `src/lib/payments/reconciliation-worker.ts` (new),
    `src/lib/payments/reconciliation-worker.test.ts` (new),
    `src/shared/lib/repositories/usage-credits.ts`,
    `src/routes/api/admin/billing/run-reconciliation.ts` (new)
  - Do: Compare Deepgram duration and Azure token usage with reservations/ledger, mark matched/
    variance/missing/duplicate, apply reviewed refunds/adjustments idempotently, alert above 1%, and
    never debit extra credit automatically after session close.
  - Verify: fixtures cover exact, rounding, <1%, >1%, missing provider, duplicate, late usage, refund,
    and unauthorized route; test provider export reconciles to ledger.

- [ ] **Add redacted metrics and operator dashboards**
  - Files: `src/shared/lib/metrics.ts`, `src/routes/api/admin/metrics.ts`,
    `src/routes/_dashboard/admin/metrics.tsx`, `src/shared/lib/log.ts`,
    `src/shared/lib/log.test.ts`
  - Do: Add booking conflict, slot latency, document backlog/failure, capture capability, transcript
    latency/reconnect/persistence, provider error, credit reservation, margin/variance, retention,
    and stale-schedule metrics. Use IDs/counters only; expand redaction for candidate/provider/payment
    fields.
  - Verify: log tests prove no CV/link/email/transcript/prompt/token/signed URL/Stripe secret;
    synthetic workflow updates dashboard and thresholds without content.

- [ ] **Add backup and restore coverage**
  - Files: `scripts/db/backup.ts`, `scripts/db/restore-test.ts`,
    `docs/operations/database-migrations.md`,
    `docs/operations/interview-runtime-verification.md`
  - Do: Include new relational tables, document R2 lifecycle/backup posture, verify restored private
    access/RLS/ledger integrity, and explicitly assert no audio artifacts exist in DB/R2/backups.
  - Verify: `pnpm db:restore-test`; restored fixture serves authorized calendar/report, denies tenant
    B/admin, balances ledger, and object inventory contains no audio MIME/key.

## Phase 12 — Final verification and rollout

- [ ] **Add Playwright projects and full E2E fixtures**
  - Files: `playwright.config.ts`, `tests/e2e/calendar.spec.ts` (new),
    `tests/e2e/scheduling.spec.ts` (new), `tests/e2e/documents.spec.ts` (new),
    `tests/e2e/billing-credits.spec.ts` (new), `tests/e2e/interview-live.spec.ts` (new),
    `tests/e2e/interview-privacy.spec.ts` (new)
  - Do: Add isolated organization/users/candidate capability, fake provider servers, R2/ClamAV,
    Stripe fixtures, deterministic time/timezone, and browser permissions. Cover happy paths and
    all acceptance/security/degradation flows from `spec.md`.
  - Verify: all projects pass repeatedly in CI and locally with traces on retry; no test depends on
    production provider credentials.

- [ ] **Run performance and concurrency verification**
  - Files: `scripts/bench/calendar-feed.mjs` (new),
    `scripts/bench/scheduling-booking.mjs` (new),
    `scripts/bench/transcript-segments.mjs` (new),
    `docs/operations/interview-runtime-verification.md`
  - Do: Seed realistic 90-day calendars/recurrence/projections, concurrent slot readers/bookers, and
    long transcript batches. Measure query count/p95, lock contention, memory, WebSocket reconnect,
    and worker batch isolation; add indexes only from evidence.
  - Verify: calendar <500 ms p95, slots <750 ms p95, zero double booking, acknowledged segment
    persistence >=99.9%, no unbounded query/memory growth.

- [ ] **Run security and privacy adversarial suite**
  - Files: `docs/architecture/threat-model.md`,
    `docs/operations/interview-runtime-verification.md`,
    `scripts/check-tenant-boundaries.mjs`
  - Do: Execute tenant A/B, admin-no-participation, stale membership, capability enumeration/replay,
    CSRF, rate bypass, SSRF, XSS, prompt injection, upload polyglot/EICAR/bomb, signed URL leakage,
    Stripe forgery/replay, provider token scope, log leakage, and direct DB-role/RLS attacks.
  - Verify: every case records pass/evidence; run `pnpm security:boundaries`,
    `pnpm security:dependencies`, and `pnpm test:rls:local` successfully.

- [ ] **Run complete static, migration, test, and build gate**
  - Files: repository-wide
  - Do: Resolve only feature-caused failures; preserve unrelated user changes; confirm Drizzle
    journal/snapshots/hashes and generated route tree match sources.
  - Verify: run `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`,
    `pnpm exec drizzle-kit check`, `pnpm test:migrations:local`, `pnpm test:rls:local`,
    `pnpm security:boundaries`, and `pnpm security:dependencies` successfully.

- [ ] **Verify unit economics in test and limited live mode**
  - Files: `docs/operations/interview-runtime-verification.md`,
    `plans/calendar-scheduling-interview-intelligence/spec.md`
  - Do: Run representative 30/60/90-minute sessions and brief/report workloads; capture billed
    Deepgram minutes, Azure tokens, Stripe fees, R2 bytes/operations, internal credits, revenue, and
    gross margin. Adjust configurable catalog before public launch; do not rewrite ledger history.
  - Verify: no uncovered provider session, ledger/provider variance <1%, no negative margin pack at
    approved cost budget, and finance sign-off recorded.

- [ ] **Roll out flags in dependency order**
  - Files: `docs/operations/interview-runtime-verification.md`,
    `.env.production.example`, production deployment configuration (external, no secrets in repo)
  - Do: Enable internal calendar; then projections; scheduling; uploads; Stripe/credits; brief;
    closed Chrome transcription; contextual questions/report. Hold each stage through its agreed
    observation window and rollback on privacy/cost/correctness threshold breach.
  - Verify: production synthetic monitor and a consented internal workflow pass per stage; dashboards,
    alerts, disable path, backup/restore, purge, and provider-region checks remain green.

- [ ] **Close Definition of Done with runtime evidence**
  - Files: `docs/operations/interview-runtime-verification.md`,
    `plans/calendar-scheduling-interview-intelligence/spec.md`,
    `plans/calendar-scheduling-interview-intelligence/plan.md`,
    `plans/calendar-scheduling-interview-intelligence/tasks.md`
  - Do: Attach dated evidence for email-to-booking, DST, race safety, scan/extraction/brief, real
    30-minute bilingual live interview, reconnect/correction/report, credits/payment/refund/
    reconciliation, purge/export/delete, tenant/private-user isolation, restore, dashboards, and
    rollback. Mark tasks/status implemented only from evidence.
  - Verify: no unchecked task, no waived acceptance criterion, no unresolved high/critical finding,
    and all production flags intended for general availability are enabled intentionally.
