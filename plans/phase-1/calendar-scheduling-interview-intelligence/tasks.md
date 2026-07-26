# Tasks: Calendar, Scheduling, and Interview Intelligence

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/spec.md),
> [`ai-expansion`](../ai-expansion/spec.md), and
> [`stripe-billing-platform`](../stripe-billing-platform/spec.md)
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
    DPA links/status, retention, training opt-out, deletion, subprocessors, region, account owner,
    and annual review date. Reference the billing platform's independent Stripe provider register;
    do not duplicate it. Complete a DPIA before production voice enablement. Store no secret values.
  - Verify: security/privacy reviewer signs the register; each regional endpoint is confirmed from a
    test response/console and every provider can be disabled independently.

- [ ] **Verify the billing platform certification dependency**
  - Files: `plans/stripe-billing-platform/tasks.md`, `docs/operations/stripe-sandbox-certification.md`,
    `docs/operations/interview-provider-register.md`
  - Do: Record the completed billing sandbox/release evidence consumed by interviews: paid
    entitlement, reserve/extend/settle/release/refund contracts, owner billing links, provider-usage
    attachment, and disabled/manual-grant beta behavior. Do not repeat selling-entity, tax,
    Checkout, catalog, refund, dispute, or accounting decisions in this plan.
  - Verify: every required billing-platform task is complete before provider-backed interview flags
    can enable; interview-only beta works with platform operator grants and all paid providers off.

- [x] **Add environment schema and kill switches**
  - Files: `src/shared/lib/env.ts`, `src/shared/lib/env.security.test.ts`, `.env.example`,
    `.env.production.example`
  - Do: Add server-only R2 endpoint/account/bucket/access keys/jurisdiction, ClamAV host/port,
    Deepgram key/EU base URL, Azure endpoint/key/deployment/API version, interview retention days,
    and interview release flags from `plan.md`, including `CANDIDATE_WEB_IMPORT_ENABLED`. Consume
    billing readiness through its server contract; do not add Stripe secrets/Prices here.
    Production validation must require regional URLs when a sensitive flag is enabled and reject
    secrets prefixed with `VITE_`.
  - Verify: env tests cover disabled minimal config, each enabled dependency, non-EU rejection,
    missing secret, malformed retention/price values, and public-secret leakage; `pnpm test
src/shared/lib/env.security.test.ts`.
  - **Evidence (2026-07-26)**: Added all 8 release flags (`CALENDAR_ENABLED` through
    `CALENDAR_OPERATIONAL_LAYERS_ENABLED`), R2/ClamAV/Deepgram/Azure OpenAI config, and 3
    retention ceilings to `src/shared/lib/env.ts`. Production-only `superRefine` requires R2+ClamAV
    when `CANDIDATE_UPLOADS_ENABLED=true` (endpoint regex-checked against
    `*.eu.r2.cloudflarestorage.com`), Deepgram key + EU base URL when
    `INTERVIEW_TRANSCRIPTION_ENABLED=true`, and Azure endpoint/key/deployment/version + EU-region
    hostname check when `SENSITIVE_AI_ENABLED=true`. `parseEnvironment()` rejects any stray
    `VITE_`-prefixed copy of an R2/ClamAV/Deepgram/Azure secret in every environment (not just
    production), since that's a static shape mistake, not a runtime dependency. Extended
    `env.security.test.ts` with a new describe block: disabled-default boot, all-dependencies-valid,
    17 individual rejection cases (missing/malformed config, non-EU endpoints, retention ceilings),
    5 VITE_-leakage rejection cases, and a "no provider config required outside production" case
    mirroring the existing enrichment precedent. `.env.example`/`.env.production.example` updated to
    match. All 62 tests in the file pass; `pnpm tsc --noEmit`, `pnpm eslint`, and the full
    `pnpm vitest run` (2373 passed) are clean. Committed as `f9e7285`.

- [x] **Install and lock reviewed dependencies**
  - Files: `package.json`, `pnpm-lock.yaml`
  - Do: Add FullCalendar Standard React/day-grid/time-grid/list/interaction/RRule packages, `rrule`,
    `@js-temporal/polyfill`, AWS S3 client/presigner, `file-type`, `pdfjs-dist`, `mammoth`,
    `ical-generator`, and `openai`. Stripe is installed by the billing dependency. Record accepted
    MIT/Apache/BSD licenses; do not install
    FullCalendar Premium or an unmaintained ClamAV wrapper.
  - Verify: `pnpm list --depth 0` has no invalid tree; `pnpm build`,
    `pnpm security:dependencies`, and a license report show no unapproved runtime license.
  - **Evidence (2026-07-26)**: Installed `@fullcalendar/{core,react,daygrid,timegrid,list,
    interaction,rrule}` — pinned all to `6.1.21` (not the newly-published `7.0.2` line for
    core/react/rrule) because `@fullcalendar/{daygrid,timegrid,list,interaction}` have not yet
    published a matching v7 release; mixing majors produced an unmet-peer error. `rrule`,
    `@js-temporal/polyfill`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `file-type`,
    `pdfjs-dist`, `mammoth`, `ical-generator`, and `openai` installed at their current latest.
    `pnpm peers check` reports no issues. Licenses verified from each package's own
    `package.json`: MIT (FullCalendar ×7, `file-type`, `ical-generator`), BSD-3-Clause (`rrule`),
    ISC (`@js-temporal/polyfill`), Apache-2.0 (`@aws-sdk/*`, `pdfjs-dist`, `openai`), BSD-2-Clause
    (`mammoth`) — all approved, no unmaintained ClamAV wrapper or FullCalendar Premium package
    installed. `pnpm build` succeeds. `pnpm security:dependencies` reports one pre-existing high
    `js-yaml` advisory via `@tanstack/react-start` → `xmlbuilder2`; confirmed via
    `git stash`/re-run that this identical finding exists on `master` before this change, so it is
    not a regression from the new dependencies. Full `pnpm tsc --noEmit` and `pnpm vitest run`
    (2373 passed) stay clean after the install.

- [x] **Define shared feature/catalog configuration**
  - Files: `src/shared/lib/interview-config.ts` (new),
    `src/shared/lib/interview-config.test.ts` (new)
  - Do: Define supported MIME/extensions, 10 MB/25 MB document and 2 MB web-import limits,
    retention defaults, Chrome desktop current/previous major matrix, capture modes/languages,
    interview operation rate-card keys/estimates, low-balance warning thresholds, recurrence horizon,
    and safe public flag DTO. Import catalog/entitlement types from billing; define no price, tax,
    grant-expiry, or pack authority here.
  - Verify: tests reject negative/zero limits, unknown rate-card key, excessive retention, and
    missing fallback; `pnpm test src/shared/lib/interview-config.test.ts`.
  - **Evidence (2026-07-26)**: Wrote `interview-config.ts` — PDF/DOCX/TXT MIME allowlist,
    10 MB/25 MB/2 MB size limits with `assertPositiveByteLimit`, retention defaults
    (90d/180d/24mo) plus `resolveRetentionDays` (org override capped by the operator ceiling from
    `env.ts`, falls back to the default when unset), a Chrome current/previous-major matrix
    (`CHROME_CURRENT_SUPPORTED_MAJOR = 139`, flagged as needing periodic operator bumps),
    `in_person`/`remote_call` capture modes (manual-only documented as a fallback *state*, not a
    third mode), `en`/`da` supported languages, a 60-day default/365-day max booking horizon,
    `INTERVIEW_RATE_CARD_KEYS` (brief=5, transcriptionPerMinute=1, report=5 — same immutable
    versioned-key convention as `billing/rate-cards.ts`/`solutions/config.ts`) with
    `getInterviewRateCardKey` throwing on an unknown operation, an
    `INTERVIEW_TYPICAL_60_MINUTE_ESTIMATE_UNITS` constant asserting the spec's 70-credit figure,
    80%/90%/10-remaining-minute low-balance thresholds, `INTERVIEW_ENTITLEMENT_TIERS` (pro/pro_max/
    team, imported `CatalogTier` from `billing/catalog.ts`), and `getInterviewFeatureFlags()`
    returning a safe public DTO. 28 tests in `interview-config.test.ts` (using the established
    `vi.mock('./env', ...)` workaround for the happy-dom `isBrowser` quirk) cover every negative/
    zero/excessive-value rejection, the unknown-rate-card-key throw, and the missing-fallback
    default. `pnpm tsc --noEmit`, `pnpm eslint`, and the full `pnpm vitest run` (2401 passed) are
    clean.

## Phase 1 — Pure domain contracts

- [ ] **Implement calendar contracts and state machine**
  - Files: `src/shared/lib/calendar.ts` (new), `src/shared/lib/calendar.test.ts` (new)
  - Do: Add event/occurrence/participant/reminder/delivery/feed DTO schemas, event types/statuses,
    source types, visibility fixed to `private`, optimistic-version and `this|following|series`
    mutation input, transition/split guards, half-open overlap helper, search/export filters, and
    explicit read-only projection discrimination.
  - Verify: tests cover every valid/invalid transition, invalid ranges, stale version mapping,
    participant DTO minimization, and projection `editable: false`; `pnpm test
src/shared/lib/calendar.test.ts`.

- [ ] **Implement timezone, recurrence, and availability calculations**
  - Files: `src/shared/lib/scheduling.ts` (new), `src/shared/lib/scheduling.test.ts` (new)
  - Do: Add availability/override/invitation/slot/consent-receipt schemas, IANA timezone validation, Temporal-based
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

- [ ] **Implement interview usage estimation arithmetic**
  - Files: `src/modules/interviews/billing.ts`, `src/modules/interviews/billing.test.ts`,
    `src/shared/lib/billing/rate-cards.ts`
  - Do: Define only interview-specific duration/token-to-unit estimation, maximum reservations,
    warning projections, and provider-usage normalization with integer units. Import platform
    reservation/ledger types and do not reimplement balance, expiry, refund, or allocation logic.
  - Verify: property-style tests cover rounding, maximums, warning boundaries, and <1% provider
    variance; a boundary test rejects local grant/ledger state machines.

- [ ] **Define provider interfaces without SDK leakage**
  - Files: `src/lib/storage/types.ts` (new), `src/lib/interviews/transcription/types.ts` (new),
    `src/lib/interviews/sensitive-ai/types.ts` (new)
  - Do: Define narrow interfaces for signed upload/download/delete/move, scan/extract, ephemeral
    transcription credentials/usage and structured sensitive completion. Billing provider types are
    imported from the billing platform. Domain layers receive normalized errors and usage, not
    vendor response types.
  - Verify: TypeScript fake adapters implement every interface without provider packages;
    `pnpm type-check`.

- [ ] **Implement the normative HTTP and error schemas**
  - Files: `src/shared/lib/interview-api.ts` (new),
    `src/shared/lib/interview-api.test.ts` (new), `src/shared/lib/api-errors.ts`
  - Do: Encode every method/route request, success DTO, authority, idempotency key, bounded range,
    pagination, and common error code from `spec.md` as named Zod schemas and discriminated unions.
    Export route-safe types only; reject organization/owner/provider/price/credit authority fields
    from client inputs. Public errors collapse unavailable capability states.
  - Verify: contract tests instantiate every route row, reject unknown fields and oversized ranges/
    batches, assert every declared error has stable HTTP mapping, and prove no private ORM/provider
    object is assignable to a public DTO; `pnpm test src/shared/lib/interview-api.test.ts`.

## Phase 2 — Calendar persistence and RLS

- [ ] **Add calendar and scheduling schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`, `docs/architecture/data-classification.md`
  - Do: Add the exact `spec.md` columns/checks for `user_calendars`, `calendar_events`,
    `calendar_event_occurrences`, `event_participants`, `calendar_event_reminders`,
    `calendar_notification_deliveries`, `availability_rules`, `availability_overrides`,
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
  - Do: Add calendar/event/occurrence/participant/reminder/delivery CRUD, search, and range queries using an injected
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
  - Do: Orchestrate create/update/move/resize/cancel/delete/search/export/range operations through
    tenant context; centralize owner/participant permissions; enforce start/end, private visibility,
    recurrence `this|following|series`, manual-overlap warning versus interview hard conflict,
    reminders, stable ICS UID/SEQUENCE, version, and event-source mutation rules.
  - Verify: service tests cover every role/action, stale membership, stale version, recurrence edit
    scope, cancel vs delete, and no admin implicit access; targeted tests pass.

- [ ] **Implement recurrence materialization worker**
  - Files: `src/lib/calendar/recurrence-worker.ts` (new),
    `src/lib/calendar/recurrence-worker.test.ts` (new),
    `src/shared/lib/repositories/calendar-worker.ts` (new),
    `src/routes/api/admin/calendar/run-worker.ts` (new)
  - Do: Expand recurring events idempotently for the configured past/future horizon, apply
    exclusions/overrides/cancellations/successor splits, prune obsolete future instances, lease
    batches by tenant, schedule reminder deliveries with occurrence/recipient/channel/offset
    idempotency, suppress cancelled/removed recipients, write job runs, and authenticate like
    existing workers using worker scope rather than a global tenant transaction.
  - Verify: repeated/concurrent runs produce identical occurrence sets; one tenant failure does not
    affect another; unauthorized route fails; run against local DB and inspect rows.

- [ ] **Implement reminder and participant-notification delivery**
  - Files: `src/lib/calendar/reminder-worker.ts` (new),
    `src/lib/calendar/reminder-worker.test.ts` (new),
    `src/routes/api/admin/calendar/run-reminders.ts` (new), `src/shared/lib/email.ts`,
    `src/shared/lib/repositories/calendar-worker.ts`
  - Do: Lease due reminders per tenant, send in-app/email delivery and stable UID/increasing SEQUENCE
    ICS `REQUEST`/`CANCEL` updates, write idempotent delivery/read state, retry transient failures with cap, and
    suppress cancelled events, removed participants, stale occurrence versions, and duplicate
    occurrence/recipient/channel/offset keys.
  - Verify: tests cover each allowed offset/channel, exactly-once concurrent delivery, retry,
    cancellation/reschedule update, participant removal, tenant isolation, and unauthorized worker;
    a test inbox imports an update and cancellation into a standards-compliant calendar.

- [ ] **Add calendar event APIs**
  - Files: `src/routes/api/calendar/events/index.ts` (new),
    `src/routes/api/calendar/events/$eventId.ts` (new),
    `src/routes/api/calendar/events/$eventId/cancel.ts` (new),
    `src/routes/api/calendar/export[.]ics.ts` (new),
    `src/routes/api/calendar/notifications.ts` (new)
  - Do: Add authenticated range/search GET, create POST, detail GET, versioned scoped PATCH/DELETE,
    cancel POST, bounded private ICS export, and own paginated notification read/mark-read using
    `requireTenantPrincipal`, tenant context, Zod request limits, CSRF protection, safe errors,
    explicit DTOs, and audit events.
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
    `src/modules/calendar/components/CalendarAgenda.tsx` (new),
    `src/modules/calendar/components/CalendarNotifications.tsx` (new)
  - Do: Add responsive FullCalendar month/week/day/list views, range fetching, search, optimistic
    drag/resize with rollback, editor/detail side panel, recurrence-scope chooser, timezone label,
    participant/reminder/default-reminder fields, overlap warning, ICS export, notification drawer/
    unread/mark-read/event navigation, agenda fallback, keyboard actions, visible focus,
    loading/empty/error/stale states, and no color-only semantics.
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
    `server/security.mjs`, `test/security/http-security.test.ts`
  - Do: Generate/hash 256-bit secrets, validate constant-time, exchange fragment token once for
    invitation-scoped secure cookie, bind expiry/revocation, replace client history, apply no-referrer
    and strict public scheduling CSP, and implement safe replay/rotation behavior.
    Note (2026-07-24): `server/security.mjs` now holds the ONE security-header/CSRF implementation
    (`server.prod.mjs` imports it; the old `src/shared/lib/security/headers.ts` duplicate is
    deleted). Its CSP is a single shared constant, so a stricter per-route scheduling CSP means
    adding a named variant export there — do not fork a second copy. The invitation cookie is a
    cookie-authenticated mutation surface, so it inherits the existing mutation-origin gate.
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
    participants, verify current individual consent receipts for every required purpose, mark invite
    booked, create consent-receipt/outbox messages, and commit together. Missing/withdrawn consent
    returns `422 consent_required`. Cancellation preserves history. Reschedule creates linked
    replacement occurrence/event state without a gap or double confirmation.
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
    `src/routes/api/public/scheduling/$invitationId/reschedule.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/withdraw.ts` (new)
  - Do: Validate invitation cookie plus CSRF, apply capability/IP rate limits, return public
    allowlists, accept normalized candidate details/slot/individual notice-version receipt IDs,
    reject incomplete consent, expose only valid lifecycle actions, and allow post-booking purpose
    withdrawal that changes affected future processing/session state without cancelling the event.
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
    picker without drag/drop, candidate details, separate unticked terms/privacy and four required
    purpose controls with notice versions, consent receipt/review/withdrawal, decline/book/cancel/
    reschedule states, expiry/conflict recovery, no analytics, and 320 px accessibility.
  - Verify: Playwright proves no booking with any missing consent, then completes signed-out mobile
    booking, receives receipt, withdraws transcription without cancelling, switches timezone,
    recovers a race, cancels/reschedules, handles expired/revoked link, keyboard-only flow, and axe.

## Phase 6 — Private documents and candidate intake

- [ ] **Add document, extraction, and consent schema/RLS**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`,
    `docs/architecture/data-classification.md`, `src/shared/lib/security/rls-policy.test.ts`
  - Do: Add exact `spec.md` columns/checks for `candidate_documents`, `document_extractions`,
    `candidate_web_imports`, and append-only `privacy_consents` with tenant composite FKs,
    generated-key uniqueness, hashes/bytes/type/status/error/expiry indexes, individual versioned
    purpose decisions/supersession/withdrawal, and owner/participant policies. Capability writes go
    through a narrowly privileged server command, never anonymous SQL grants.
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
  - Do: Issue quota-bound signed upload, validate completion metadata, record each unticked positive
    purpose act with rendered notice/version/evidence hash, expose review/withdrawal, and issue
    authorized five-minute clean-download only to owner/participants. Apply CSRF, capability/IP rate
    limit, safe status DTO, and audit without filename/email/token.
  - Verify: tests cover quota, forged key/size/type/checksum, cross-invitation completion, pending/
    rejected download, admin denial, tenant B, URL expiry, consent version, and withdrawal.

- [ ] **Implement policy-controlled public-web import**
  - Files: `src/lib/enrichment/network.ts`, `src/lib/enrichment/network.test.ts`,
    `src/lib/enrichment/policies.ts`, `src/lib/enrichment/policies.test.ts`,
    `src/lib/enrichment/robots.ts`, `src/lib/enrichment/robots.test.ts`,
    `src/lib/scheduling/web-import-worker.ts` (new),
    `src/lib/scheduling/web-import-worker.test.ts` (new),
    `src/shared/lib/repositories/interview-documents.ts`,
    `src/routes/api/admin/documents/run-web-imports.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/links/$linkId/import.ts` (new)
  - Do: Reuse the shared enrichment safety envelope and source registry. Permit only `official_api`
    or `authorized_crawl`; create candidate personal/project host eligibility only after a positive,
    versioned ownership/authorization attestation; keep LinkedIn/X/Meta `user_submitted` and URL-only
    without source permission. Enforce HTTPS, honest user agent, RFC 9309 fail-closed robots, public A/AAAA on every
    revalidated redirect, no credentials/nonstandard ports, five redirects, 10 seconds, 2 MB,
    HTML/text/PDF allowlist, host Redis rate/concurrency limit, no JavaScript, sanitized visible-text
    extraction, stable evidence IDs/hashes, raw-body discard, retention, idempotency, and redacted
    job run.
  - Verify: fake-host tests cover allowed import, robots allow/disallow/unreachable, LinkedIn hard
    block, localhost/private/link-local/metadata IPv4/IPv6, DNS rebinding, redirect escape, auth,
    port/scheme, compressed/oversized body, MIME mismatch, active HTML, timeout, Redis unavailable,
    duplicate content, tenant isolation, raw-body absence, and unauthorized worker/API.

- [ ] **Add candidate links and intake UI**
  - Files: `src/modules/scheduling/components/CandidateIntake.tsx` (new),
    `src/modules/scheduling/components/DocumentUploader.tsx` (new),
    `src/modules/scheduling/components/ConsentFields.tsx` (new),
    `src/modules/scheduling/components/CandidatePortal.tsx`
  - Do: Add LinkedIn/personal/other URL validation, source-policy/import status, a separate unticked
    ownership/authorization attestation for each importable personal/project host, notes, resumable
    status UI, PDF/DOCX/TXT limits, four separate required purpose controls, scan/extraction states,
    delete/retry, and explicit URL-only state for blocked platforms. Booking may finish while
    documents and permitted websites continue processing.
  - Verify: Playwright uploads valid and EICAR/fake-type/oversized fixtures, imports an approved
    public site, keeps LinkedIn URL-only, proves missing consent blocks booking, accepts all purposes,
    books, and sees correct processing/error/withdrawal state.

## Phase 7 — Consume the Stripe billing platform

- [ ] **Register interview rate cards with the billing platform**
  - Files: `src/shared/lib/billing/rate-cards.ts`, `src/modules/interviews/billing.ts`, `src/modules/interviews/billing.test.ts`
  - Do: Add versioned interview brief, live transcription, contextual-question, and final-report unit
    rules plus maximum reservations/durations. Import the platform contracts; do not create Stripe,
    catalog, grant, ledger, checkout, refund, auto-recharge, or reconciliation code here.
  - Verify: contract tests assert exact estimates/maximums and a boundary test fails any interview
    module that imports Stripe or billing tables directly.

- [ ] **Wrap every interview provider boundary in reserve and settlement**
  - Files: `src/modules/interviews/billing.ts`, `src/modules/interviews/billing.test.ts`, `src/shared/lib/billing/feature-authorization.ts`
  - Do: Call entitlement check and reserve before brief/STT/question/report provider access; extend
    long-running live work, settle actual use with provider references, and release/refund on failure.
    Stop only paid provider capture at zero and preserve manual notes/interview controls.
  - Verify: fake-provider tests cover insufficient entitlement/credits, duplicate/retry, disconnect,
    extension denial, grant expiry during interview, provider failure, actual-vs-reserved settlement,
    and prove no provider request starts before reservation.

- [ ] **Show platform-owned credit state in interview UX**
  - Files: `src/modules/interviews/components/CreditBalance.tsx`, `src/modules/interviews/components/CreditBalance.test.tsx`, `src/routes/api/billing/summary.ts`
  - Do: Render the role-minimized platform summary, 80/90/ten-minute/zero live warnings, and owner
    links to billing/pack/auto-recharge settings. Do not expose payment mutations or duplicate the
    general billing settings inside interview pages.
  - Verify: owner/admin/member, active/grace/blocked, low/zero, and stale summary component tests pass
    with accessible throttled announcements and no Stripe/provider object in the DTO.

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
    output, prompt version, and Pro/Pro Max/Team allowance. Route it through sensitive client
    selection.
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
  - Do: Assemble role/profile/document and approved public-web extraction evidence with stable source
    IDs/provenance, reserve 5 credits, call sensitive task, validate evidence, save new draft version,
    settle/refund, support section regeneration/manual edits, and create deterministic fallback when
    disabled/failing. URL-only restricted-platform links are displayed but never treated as fetched
    factual evidence.
  - Verify: tests cover ready/pending/rejected docs and websites, LinkedIn URL-only, no evidence, provider invalid/timeout, credit
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
  - Do: Generate a Deepgram 30-second JWT and explicit
    `wss://api.eu.deepgram.com/v1/listen` session configuration for streaming multilingual STT:
    remote Nova-3 interleaved linear PCM 16 kHz with `channels=2&multichannel=true` and in-person
    mono Nova-3 with streaming diarization; smart formatting, provider request ID, and normalized
    termination duration. Never return master key or permit management/
    non-transcription endpoints; the WebSocket may continue after token expiry but reconnect obtains
    a new token.
  - Verify: fake/live synthetic tests cover exact EU URL, 30-second TTL/scope, master-key absence,
    separate remote channels, in-person diarization, invalid response, expired initial connect,
    reconnect token, final segment shape, unknown speaker, and usage duration.

- [ ] **Implement interview session service**
  - Files: `src/lib/interviews/session-service.ts` (new),
    `src/lib/interviews/session-service.test.ts` (new),
    `src/shared/lib/repositories/interviews.ts`
  - Do: Start/ready/live/pause/resume/finish/fail/abandon transitions, participant permission,
    stored per-purpose consent recheck, candidate withdrawal state polling/SSE and ten-second hard
    stop, organizer verbal-reminder acknowledgement, initial/live credit reservation and extension,
    heartbeat expiry, provider usage attach, final settlement, and redacted audit.
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
  - Do: Enforce current/previous desktop Chrome on macOS/Windows for remote mode. Request
    `getDisplayMedia` from a user gesture with browser-tab preference, self/monitor/system-audio
    exclusion and local playback; require a separate meeting tab with audio; inspect
    `displaySurface`; stop the mandatory video track immediately and before provider connect; keep
    microphone as channel 0 and meeting tab as channel 1 in interleaved linear PCM 16 kHz; use
    diarization only for in-person and reject remote multichannel failure to manual-only; implement
    WebSocket parsing/reconnect/device change and guaranteed track/context/socket cleanup. Do not
    import/use `MediaRecorder`, attach video, send video frames, or construct audio Blob/object URL.
  - Verify: mocked media/WebSocket tests cover browser/version/OS matrix, non-tab/no-audio/self-tab,
    permission denial, user-gesture requirement, video stopped before connect, zero video bytes,
    distinct channel labels, in-person diarization, track end, reconnect, unload, pause/stop, and
    static assertions forbidding `MediaRecorder`, audio Blob, video transport/element; manual Chrome
    preflight confirms devices.

- [ ] **Build dedicated live interview workspace**
  - Files: `src/routes/_dashboard/interviews/$interviewId/live.tsx` (new),
    `src/modules/interviews/components/LiveInterviewPage.tsx` (new),
    `src/modules/interviews/components/CapturePreflight.tsx` (new),
    `src/modules/interviews/components/LiveTranscript.tsx` (new),
    `src/modules/interviews/components/InterviewNotes.tsx` (new),
    `src/modules/interviews/components/InterviewControls.tsx` (new),
    `src/modules/interviews/components/SpeakerMapper.tsx` (new)
  - Do: Add brief sidebar, stored-consent receipt and verbal-reminder acknowledgement, capture
    banner, Chrome meeting-tab instructions/preflight, timer, live transcript, deterministic remote
    source labels/in-person speaker correction, markers, private notes, pause/reconnect/finish,
    remaining credits, withdrawal hard-stop, manual-only mode, screen-reader throttled announcements,
    reduced motion, and 320 px layout. Do not allow microphone-only remote transcription; offer
    manual-only instead.
  - Verify: component/Playwright with fake provider covers permissions, both capture modes,
    microphone-only remote rejection/manual-only transition, interim/final rendering, correction,
    offline outbox, pause, withdrawal, zero credit, finish, keyboard, and axe.

- [ ] **Run real browser capture beta verification**
  - Files: `docs/operations/interview-runtime-verification.md` (new)
  - Do: Test current/previous stable Chrome on macOS/Windows using in-person microphone and separate
    Meet/Zoom/Teams web-tab audio, headphones/speakers/external mic, Spanish/English, noise and crosstalk. Record
    capability—not candidate content—latency, loss, diarization corrections, cleanup, and failures.
    Document Edge beta and Safari/Firefox/mobile/native-app manual-only degradation.
  - Verify: two consented/synthetic 30-minute sessions finish/reconnect with 99.9% acknowledged final
    segments, correct channel attribution/billing variance, candidate withdrawal stop within ten
    seconds, and DevTools/storage/network inspection showing no audio or video artifact.

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
  - Do: Include owned/participating calendar, notifications, invitations, submissions, links,
    public-web provenance/extractions, documents metadata/extraction, brief/transcript/report/consent,
    and credit history in authorized export with private file links handled safely; delete/anonymize
    according to ownership/participant and organization lifecycle; add interview retention controls/
    status UI.
  - Verify: export fixture contains only subject-authorized data/no secrets/object keys; deletion
    removes storage/provider/cache artifacts; cross-user participant data follows documented policy;
    existing privacy tests remain green.

- [ ] **Update legal notices and consent copy**
  - Files: `src/routes/_landing/legal/privacy.tsx`,
    `src/routes/_landing/legal/terms.tsx`, `src/shared/lib/legal.ts`,
    `src/shared/lib/legal.test.ts`, `docs/operations/interview-provider-register.md`
  - Do: After legal review, describe controller, documents, approved public-web import, transient
    audio capture, stored transcript, sensitive AI, four required purposes, legal basis, processors/
    regions, retention, rights, withdrawal consequences, no training, no automated decision, and
    credit billing. Version the exact independently accepted controls and preserve old versions.
    Never describe booking consent as permission for unrelated future processing.
  - Verify: legal snapshot/version tests pass; portal renders and records each exact notice version;
    no `accept all` API field exists; consent receipt, withdrawal, and contact paths work; reviewer
    sign-off is recorded.

- [ ] **Complete EU AI Act classification and operational controls**
  - Files: `docs/compliance/interview-ai-act-classification.md` (new),
    `docs/operations/interview-ai-human-oversight.md` (new),
    `docs/operations/interview-ai-post-market-monitoring.md` (new),
    `src/shared/lib/ai/tasks.test.ts`, `src/shared/lib/interviews.test.ts`,
    `src/modules/interviews/components/InterviewBriefEditor.tsx`,
    `src/modules/interviews/components/InterviewReportEditor.tsx`,
    `src/routes/_landing/legal/privacy.tsx`
  - Do: For each `interview-brief-generate`, `interview-followup-suggest`, and
    `interview-report-generate` task, document intended purpose, Annex III employment context,
    Article 6(3) material-influence/preparatory-task assessment, classification owner/version,
    evidence, foreseeable misuse, supported languages/capture modes, accuracy/limitations, protected-
    trait proxy and bias evaluation, traceability, human oversight, AI-literacy instructions,
    candidate disclosure/contest path, incident response, and post-market thresholds. If the
    preparatory exception is not supportable, block launch behind `SENSITIVE_AI_ENABLED` until the
    full applicable high-risk provider/deployer controls are complete. Label every output `AI draft`;
    prevent automatic rank/score/status/hire decisions in schema, API, UI, and analytics.
  - Verify: legal/compliance sign-off is dated; test fixtures across Spanish/English and protected-
    trait proxy prompts reject prohibited influence; UI requires human review and shows disclosure/
    limitations; static tests prove no candidate-status write from AI paths; monitoring/incident
    drill passes; release checklist tracks Article 50 from 2026-08-02 and the then-current employment
    high-risk enforcement date.

- [ ] **Implement provider usage reconciliation**
  - Files: `src/lib/interviews/usage-reconciliation.ts` (new),
    `src/lib/interviews/usage-reconciliation.test.ts` (new),
    `src/shared/lib/billing/feature-authorization.ts`,
    `src/shared/lib/billing/reconciliation.ts`
  - Do: Normalize Deepgram duration and Azure token usage, attach provider references/actuals to the
    platform settlement, and report matched/variance/missing/duplicate evidence through the billing
    reconciliation contract. Request reviewed platform `refundUsage` adjustments above policy; never
    write the ledger or create a second billing worker/route and never debit extra after close.
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
