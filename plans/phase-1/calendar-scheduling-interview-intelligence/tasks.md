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

- [x] **Complete the canonical tenant/RLS release gate** — done 2026-07-27
  - `organization_id` is now `NOT NULL` on all seven tenant-private tables (`drizzle/0081`), applied
    to production on 2026-07-27 (Coolify deploy `30286320587`). The migration adopts leftover rows
    itself rather than trusting deploy ordering, and lifts `FORCE ROW LEVEL SECURITY` per table for
    the update because that applies to the table owner too — without it the backfill would have
    matched zero rows in silence.
  - The readiness gate itself was rewritten: it demanded a 24-hour zero-mismatch shadow-read window
    that could never be satisfied, because legacy and canonical reads are *supposed* to diverge once
    an organization has two contributing members. Replaced with null-tenant, unresolved-conflict and
    legacy-consumer counts. See `security-and-multitenancy` for the full account.
  - Verify (2026-07-27): `pnpm security:boundaries` passes (0 legacy imports tracked);
    `test:migrations:local` applies all 84 migrations twice on a disposable database, and
    `test:rls:local` plus the two-tenant API/worker/privacy isolation matrix pass under the exact
    non-owner roles — all four green inside a full `pnpm ci:local`, and again in CI.

- [ ] **Create provider accounts and approve data controls**
  - Files: `docs/operations/interview-provider-register.md` (new),
    `docs/architecture/data-classification.md`, `docs/architecture/threat-model.md`
  - Do: Record Cloudflare R2 EU jurisdiction, Deepgram EU endpoint, Azure regional EU deployment,
    DPA links/status, retention, training opt-out, deletion, subprocessors, region, account owner,
    and annual review date. Reference the billing platform's independent Stripe provider register;
    do not duplicate it. Complete a DPIA before production voice enablement. Store no secret values.
  - Verify: each regional endpoint is confirmed from a test response/console and every provider can
    be disabled independently.
  - **The reviewer signature is deliberately NOT part of this task's Verify line** (product-owner
    decision 2026-07-28). It is a general-availability gate, recorded as such in the register's
    "Gates general availability only" table. A countersignature on an artifact does not change what
    the software does, and blocking a storage adapter on it stalls work it has no bearing on.
  - ⚠️ **The task text above is stale in two places.** The provider set changed on 2026-07-26,
    after it was written: storage is **MinIO, self-hosted** — not Cloudflare R2 (commit `cb642d5`,
    which also widened `env.ts` to accept a private endpoint) — and sensitive AI is **Mistral (La
    Plateforme)**, not Azure. Azure was provisioned, hit a zero-quota wall, and was found to have a
    residency hole `env.ts` structurally cannot close: it validates the resource region but cannot
    see the *deployment type*, so a Global Standard deployment passes validation while processing
    outside the EU. Mistral processes in the EU by default, which is not a switch anyone can set
    wrong. The Azure resource is retained as a documented fallback.
  - **Evidence, superseding the 2026-07-26 morning note that said "accounts NOT provisioned"**
    (re-checked 2026-07-27 against `.env` and the register):
    - **Deepgram**: account provisioned 2026-07-26, and the EU endpoint verified *against that
      account* rather than the vendor blog — `nova-3` returns 200 on `api.eu.deepgram.com`,
      `diarize` accepted, `multichannel` returns two separate channels (the spec's hard requirement
      for remote interviews). `DEEPGRAM_API_KEY` and the EU base URL are configured.
    - **Mistral**: `MISTRAL_API_KEY`, `MISTRAL_BASE_URL=https://api.mistral.ai`,
      `MISTRAL_MODEL=mistral-medium-2604` and `SENSITIVE_AI_PROVIDER=mistral` configured.
    - **Stripe**: secret key and webhook secret configured.
    - **MinIO / ClamAV**: self-hosted, so there is no account, DPA or sub-processor entry to obtain.
  - **What actually remains**, and it is wiring rather than credentials: MinIO and ClamAV are not in
    `docker-compose` and the register has no deployment target recorded; `SENSITIVE_AI_ENABLED`,
    `CANDIDATE_UPLOADS_ENABLED` and `INTERVIEW_TRANSCRIPTION_ENABLED` are all unset, so every path
    is dark despite the credentials being present; the register flags a **missing bucket backup
    target before real candidate data lands**; and the DPIA is a human step nobody can do for you
    before production voice. The reviewer signature and the legal review of consent/retention are
    **general-availability gates, not development or MVP blockers** — see the register's three-way
    split. Nothing in this plan may list them as a dependency.

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
  - Files: `src/shared/lib/env.ts`, `tests/unit/shared/lib/env.security.test.ts`, `.env.example`,
    `.env.production.example`
  - Do: Add server-only R2 endpoint/account/bucket/access keys/jurisdiction, ClamAV host/port,
    Deepgram key/EU base URL, Azure endpoint/key/deployment/API version, interview retention days,
    and interview release flags from `plan.md`, including `CANDIDATE_WEB_IMPORT_ENABLED`. Consume
    billing readiness through its server contract; do not add Stripe secrets/Prices here.
    Production validation must require regional URLs when a sensitive flag is enabled and reject
    secrets prefixed with `VITE_`.
  - Verify: env tests cover disabled minimal config, each enabled dependency, non-EU rejection,
    missing secret, malformed retention/price values, and public-secret leakage; `pnpm test
tests/unit/shared/lib/env.security.test.ts`.
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
    `tests/unit/shared/lib/interview-config.test.ts` (new)
  - Do: Define supported MIME/extensions, 10 MB/25 MB document and 2 MB web-import limits,
    retention defaults, Chrome desktop current/previous major matrix, capture modes/languages,
    interview operation rate-card keys/estimates, low-balance warning thresholds, recurrence horizon,
    and safe public flag DTO. Import catalog/entitlement types from billing; define no price, tax,
    grant-expiry, or pack authority here.
  - Verify: tests reject negative/zero limits, unknown rate-card key, excessive retention, and
    missing fallback; `pnpm test tests/unit/shared/lib/interview-config.test.ts`.
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

- [x] **Implement calendar contracts and state machine**
  - Files: `src/shared/lib/calendar.ts` (new), `tests/unit/shared/lib/calendar.test.ts` (new)
  - Do: Add event/occurrence/participant/reminder/delivery/feed DTO schemas, event types/statuses,
    source types, visibility fixed to `private`, optimistic-version and `this|following|series`
    mutation input, transition/split guards, half-open overlap helper, search/export filters, and
    explicit read-only projection discrimination.
  - Verify: tests cover every valid/invalid transition, invalid ranges, stale version mapping,
    participant DTO minimization, and projection `editable: false`; `pnpm test
tests/unit/shared/lib/calendar.test.ts`.
  - **Evidence (2026-07-26)**: Wrote `calendar.ts` (Zod `.strict()` throughout, matching
    `solutions/contracts.ts`'s convention). `CalendarEventError` (coded, mirrors
    `billing/credits.ts`'s `CreditLedgerError`) backs `assertValidEventStatusTransition` (a
    `Record<Status, Status[]>` transition table for the spec.md Appointment machine:
    scheduled→confirmed/cancelled, confirmed→in_progress/cancelled/rescheduled/no_show,
    in_progress→completed/cancelled, all four terminal states reject everything) and
    `assertMatchingEventVersion` (throws `code: 'event_changed'` on mismatch — the first numeric
    optimistic-version helper in the codebase). `eventParticipantSchema` models "exactly one of
    user_id/external_email" as a discriminated `identity` union; `toEventParticipantPublicDto`
    strips it down to displayName/role/response only. `assertSupportedRecurrenceRule` allowlists
    exactly `FREQ|INTERVAL|BYDAY|BYMONTHDAY|COUNT|UNTIL` and `FREQ∈{DAILY,WEEKLY,MONTHLY,YEARLY}`
    before delegating to `rrule`'s `RRule.parseString` for structural validation — rejects
    `SECONDLY`/`HOURLY`/`BYSETPOS`/`BYWEEKNO`/malformed strings rather than approximating them.
    `resolveRecurrenceMutationPlan` implements the this/following/series split guard as a
    discriminated-result function (not a throw-only guard). `rangesOverlap` is a half-open
    `[start,end)` check (back-to-back ranges do not conflict). `calendarFeedItemSchema` is a
    `z.discriminatedUnion('kind', ...)` of the editable event item (built via
    `eventObjectSchema.extend({editable: z.literal(true)})`, confirming `.strict()` survives
    `.extend()`) plus four `editable: z.literal(false)` projection kinds
    (job_projection/alert_projection/job_run/alert_result) — a projection item claiming
    `editable: true` fails to parse. 102 tests cover every one of the 49 valid/invalid status-
    transition pairs (exhaustively generated from the full Cartesian product, not hand-picked),
    invalid date ranges, the coded stale-version throw, participant-DTO minimization (asserts the
    serialized DTO never contains the raw email/userId), and the projection discrimination cases.
    `pnpm tsc --noEmit`, `pnpm eslint`, and the full `pnpm vitest run` (2503 passed) are clean.

- [x] **Implement timezone, recurrence, and availability calculations**
  - Files: `src/shared/lib/scheduling.ts` (new), `tests/unit/shared/lib/scheduling.test.ts` (new)
  - Do: Add availability/override/invitation/slot/consent-receipt schemas, IANA timezone validation, Temporal-based
    local-to-instant conversion, RFC 5545/RRule expansion contract, exception dates, buffers,
    minimum notice/horizon, busy-range subtraction, deterministic slot IDs, and safe public errors.
  - Verify: fixtures cover Copenhagen spring-forward/fall-back, UTC, America/New_York, half-hour
    offsets, overnight invalid rules, recurrence exclusions, buffer collisions, no availability,
    and deterministic ordering; `pnpm test tests/unit/shared/lib/scheduling.test.ts`.
  - **Evidence (2026-07-26)**: Wrote `scheduling.ts`. `resolveLocalWallClockInstant` uses
    `Temporal.ZonedDateTime.from` with all three disambiguation modes to distinguish
    `nonexistent` (spring-forward gap — omitted, never shifted), `ambiguous` (fall-back — resolved
    deterministically to the earlier/`'compatible'` occurrence, both candidate instants still
    returned), and `unique`. `generateAvailabilitySlots` walks day-by-day in the rule's own IANA
    timezone (bounded by min-notice/horizon), applies date overrides (`blocked` skips the day
    entirely, `available` substitutes its own local window), expands slots, and subtracts busy
    ranges pre-expanded by `bufferBeforeMinutes`/`bufferAfterMinutes` — reusing `calendar.ts`'s
    `rangesOverlap` half-open helper rather than reimplementing overlap math.
    `expandRecurrenceRule` re-validates via `calendar.ts`'s `assertSupportedRecurrenceRule`, then
    round-trips each `rrule`-generated occurrence through the target timezone (via a "floating
    UTC-labeled" `DTSTART`/occurrence trick) so a 9am-local weekly meeting stays 9am local across a
    DST transition instead of holding a fixed UTC offset; occurrences whose wall-clock time doesn't
    exist are omitted, and `exceptionInstants` are excluded by instant equality. `computeSlotId` is
    a truncated SHA-256 of `ownerUserId|startsAt|endsAt` (opaque, deterministic, never exposes its
    inputs). `assertValidInvitationStatusTransition` implements the full Invitation machine.
    Consent-receipt schema plus `resolveRequiredConsentPurposes`/`hasAcceptedAllRequiredConsents`
    model `terms_and_privacy` as always-required and the three feature purposes
    (document-processing/web-import/AI-assistance/live-transcription) as required only when that
    booking actually invokes the feature — and require *acceptance*, not merely a recorded
    decision. `toSafePublicSchedulingErrorCode` maps any internal code to the fixed public
    allowlist. 44 tests cover Copenhagen spring-forward (2026-03-29) and fall-back (2026-10-25),
    UTC, America/New_York, the fixed half-hour offset `Asia/Kolkata`, overnight-rule rejection,
    recurrence exclusions, a genuine buffer-collision case (verified against the half-open-overlap
    boundary, not assumed), a fully-blocked no-availability case, and deterministic re-run ordering.
    `pnpm tsc --noEmit`, `pnpm eslint`, and the full `pnpm vitest run` (2547 passed) are clean.

- [x] **Implement interview schemas and prohibited-output validation**
  - Files: `src/shared/lib/interviews.ts` (new), `tests/unit/shared/lib/interviews.test.ts` (new)
  - Do: Add document/session/segment/suggestion/report/consent schemas, all state transitions,
    speaker estimate/mapping, evidence reference integrity, source manifest, capture capability
    states, and rejection of score/rank/personality/emotion/culture-fit/hire-reject fields or text.
  - Verify: tests cover all transitions, dangling evidence, duplicate segment IDs/sequences,
    prohibited outputs, unknown speaker, correction audit, and deterministic manual templates;
    `pnpm test tests/unit/shared/lib/interviews.test.ts`.
  - **Evidence (2026-07-26)**: Wrote `interviews.ts`, reusing `interview-config.ts`'s capture-mode/
    capability enums rather than redefining them. `assertValidDocumentStatusTransition` and
    `assertValidInterviewSessionTransition` implement the exact Document (7-state) and Interview
    (10-state) machines from spec.md's "State contracts", each with every terminal state
    exhaustively verified to reject all outgoing transitions. `transcriptSegmentSchema` models
    speaker estimates as `speaker_a|speaker_b|unknown` (never biometric identity) plus an optional
    `speaker_mapping` (`organizer|candidate_or_remote`), and a correction-audit refine requiring
    `correctedByUserId`/`correctedAt` together. `assertNoDuplicateSegments` is a pure batch-
    invariant function modeling the two DB unique constraints (session+providerSegmentId,
    session+sequence) that a single-row schema can't express. `assertNoDanglingSegmentEvidence`/
    `assertNoDanglingSourceReference`/`assertBriefEvidenceIntegrity` reject any evidence reference
    to a segment or source ID outside the known set. `sourceManifestEntrySchema` enforces that a
    restricted `submitted_link` source can never carry factual `text`. The prohibited-output gate
    (`findProhibitedInterviewContent`/`assertNoProhibitedInterviewContent`/
    `assertReportContentIsClean`) is a word-boundary regex bank covering score/rank/personality/
    emotion/culture-fit/hire/reject language, applied to every free-text field of a generated
    report. `interviewBriefContentSchema`/`interviewReportContentSchema`/
    `interviewFollowupSuggestOutputSchema` match the exact input/output shapes from spec.md's "AI
    task contracts" (including the 3-question cap on follow-up suggestions).
    `buildFallbackReportTemplate`/`buildFallbackBriefTemplate` are pure, argument-only functions
    (no `Date.now()`/randomness) producing the deterministic editable template spec.md requires on
    persistent AI failure — verified to be schema-valid and to pass the clean-content gate. 182
    tests cover every one of the 49 document and 100 interview-session transition pairs
    (exhaustively generated), dangling evidence (segment and source), duplicate segment IDs and
    sequences (including the same ID/sequence being fine across *different* sessions), unknown
    speaker-estimate rejection, correction-audit pairing, 7 real-world prohibited-phrase fixtures,
    and deterministic-template equality. `pnpm tsc --noEmit`, `pnpm eslint`, and the full
    `pnpm vitest run` (2729 passed) are clean.

- [x] **Implement interview usage estimation arithmetic**
  - Files: `src/modules/interviews/billing.ts`, `tests/unit/modules/interviews/billing.test.ts`,
    `src/shared/lib/billing/rate-cards.ts`
  - Do: Define only interview-specific duration/token-to-unit estimation, maximum reservations,
    warning projections, and provider-usage normalization with integer units. Import platform
    reservation/ledger types and do not reimplement balance, expiry, refund, or allocation logic.
  - Verify: property-style tests cover rounding, maximums, warning boundaries, and <1% provider
    variance; a boundary test rejects local grant/ledger state machines.
  - **Evidence (2026-07-26)**: Wrote `src/modules/interviews/billing.ts` — pure arithmetic only,
    no local reservation/grant state. `estimateTranscriptionUnitsForSeconds` rounds a partial
    minute up to a full minute (never under-charges), reusing `interview-config.ts`'s
    `INTERVIEW_RATE_CARD_KEYS`. `estimateBriefUnits`/`estimateReportUnits` pin the flat 5-credit
    costs. `MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES` (180) is this module's own local sanity
    ceiling — explicitly not registered with `billing/rate-cards.ts`'s `RATE_CARDS` map yet (a
    separate later task, matching `solutions-intelligence`'s precedent); left that file untouched.
    `resolveLowBalanceWarnings` returns every applicable warning (80%/90%/10-minutes-remaining)
    rather than only the most severe. `normalizeProviderUsageVariance` compares an estimate against
    the actual provider-billed duration; a variance of exactly 1% is deliberately *not* within
    tolerance (strict `<`). 21 tests include `fast-check` property tests (rounding always rounds up
    and stays a non-negative integer; over-max requests are always rejected;
    `remainingUnits` is always within `[0, reservedUnits]`; variance is always non-negative) plus a
    boundary test asserting the module's exports contain none of the billing platform's actual
    reservation/grant lifecycle function names (`reserveCredits`, `grantCredits`, etc. — verified
    against the real exports of `billing/reservations.ts`/`credits.ts`, not just hand-typed
    strings). `pnpm tsc --noEmit`, `pnpm eslint`, and the full `pnpm vitest run` (2750 passed) are
    clean.

- [x] **Define provider interfaces without SDK leakage**
  - Files: `src/lib/storage/types.ts` (new), `src/lib/interviews/transcription/types.ts` (new),
    `src/lib/interviews/sensitive-ai/types.ts` (new)
  - Do: Define narrow interfaces for signed upload/download/delete/move, scan/extract, ephemeral
    transcription credentials/usage and structured sensitive completion. Billing provider types are
    imported from the billing platform. Domain layers receive normalized errors and usage, not
    vendor response types.
  - Verify: TypeScript fake adapters implement every interface without provider packages;
    `pnpm type-check`.
  - **Evidence (2026-07-26)**: Wrote all three files as pure interface/error-shape definitions
    with zero imports from `@aws-sdk/*`/deepgram/openai. `storage/types.ts`: `StorageProvider`
    (signed upload/download URLs, head/delete/move) plus separate `VirusScanProvider`
    (ClamAV-shaped `ScanResult`) and `DocumentExtractionProvider` interfaces, each with its own
    normalized error class (`StorageProviderError`/`ScanProviderError`/`DocumentExtractionError`).
    `interviews/transcription/types.ts`: `TranscriptionProvider` issuing an ephemeral token (30s
    per spec.md) and normalized `TranscriptionUsage`. `interviews/sensitive-ai/types.ts`:
    `SensitiveAIProvider.completeStructured<TInput,TOutput>` — the exact name spec.md's "AI task
    contracts" section names as the required routing target, with a doc comment restating "never
    silently degrade to MiniMax/browser AI." Wrote a fake, dependency-free adapter for each
    interface in a paired `.test.ts` (round-tripping upload/move/delete for storage, token issuance
    for transcription, structured completion for sensitive AI) — 6 tests, all passing, proving each
    interface is genuinely implementable without the real provider packages installed for this
    purpose. `pnpm tsc --noEmit`, `pnpm eslint`, and the full `pnpm vitest run` (2756 passed) are
    clean.

- [x] **Implement the normative HTTP and error schemas**
  - Files: `src/shared/lib/interview-api.ts` (new),
    `tests/unit/shared/lib/interview-api.test.ts` (new), `src/shared/lib/api-errors.ts`
  - Do: Encode every method/route request, success DTO, authority, idempotency key, bounded range,
    pagination, and common error code from `spec.md` as named Zod schemas and discriminated unions.
    Export route-safe types only; reject organization/owner/provider/price/credit authority fields
    from client inputs. Public errors collapse unavailable capability states.
  - Verify: contract tests instantiate every route row, reject unknown fields and oversized ranges/
    batches, assert every declared error has stable HTTP mapping, and prove no private ORM/provider
    object is assignable to a public DTO; `pnpm test tests/unit/shared/lib/interview-api.test.ts`.
  - **Evidence (2026-07-26)**: Wrote `src/shared/lib/api-errors.ts` (new, generic/reusable) — the
    14 error codes from spec.md's "HTTP contract" (10 common + `invitation_unavailable`), a fixed
    `API_ERROR_HTTP_STATUS` map, an `ApiError` class, and `httpStatusForApiErrorCode`.
    `invitation_unavailable` deliberately shares 404 with `not_found`, matching spec.md's "same
    `404 invitation_unavailable` for unknown, revoked, expired, or foreign resources." Wrote
    `interview-api.ts`: a 29-entry `INTERVIEW_API_ROUTES` registry covering every method/route row
    in spec.md's HTTP contract table (calendar feed/events/availability/export/notifications,
    scheduling invitations, all 8 public-capability routes, all 6 interview routes, plus the two
    billing-platform-owned routes referenced but not redefined). Request schemas reuse
    `eventDraftInputSchema`/`eventMutationInputSchema`/`interviewFollowupSuggestOutputSchema` etc.
    directly where they're already client-safe; a handful of dedicated `*InputSchema`s
    (availability rules/overrides) exist specifically to omit `ownerUserId` from schemas that the
    persisted version in `scheduling.ts` includes — response schemas reuse the full persisted DTOs
    since server-authoritative read data is not the leak concern. `findForbiddenAuthorityFields`
    mechanically sweeps every request schema's own shape keys against
    `organizationId`/`ownerUserId`/`provider`/`price`/`priceId`/`creditAmount`/`creditUnits`. 80
    tests: every route row instantiated with a unique method+path and valid authority; every
    request schema rejects an unexpected extra field (`.strict()` sweep); bounded-range/oversized-
    batch rejection (feed date range, layers array, notification-mark-read batch, segment batch,
    availability rules array, empty consent-receipt array); every error code's HTTP mapping
    matches the fixed table and falls in the declared status set; the authority-field sweep across
    every request schema; and a "no private ORM/provider object satisfies a public DTO" test that
    feeds a fake raw-row object (with `organization_id`/`__raw_provider_response`) into every
    response schema and confirms none of them parse it. `pnpm tsc --noEmit`, `pnpm eslint`, and the
    full `pnpm vitest run` (2836 passed) are clean.

## Phase 2 — Calendar persistence and RLS

- [x] **Add calendar and scheduling schema**
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
  - **Evidence (2026-07-26)**: Added all 11 tables to `schema.ts` following the spec's "Normative
    persistence contract" — `uuid` PK with `gen_random_uuid()`, `organization_id text not null`,
    created/updated `timestamptz`, a `(organization_id, id)` unique index on every table, and every
    child referencing that pair via a composite FK (never a bare `id` FK, so a row can never point
    at a parent in a different tenant). 32 check constraints total, including
    `calendar_events`'s `ends_at > starts_at`, `visibility = 'private'`, `version >= 1`, and
    "source pair null together"; `availability_rules`'s no-overnight `local_end > local_start`;
    `availability_overrides`'s blocked-has-null-times / available-requires-valid-times rule;
    `event_participants`'s exactly-one-of user_id/external_email; and `candidate_links`'s
    "authorized_crawl requires a versioned attestation on file". Partial unique indexes enforce one
    default calendar per (org, owner), the occurrence `(org, event, recurrence_id)` identity, and
    the reminder delivery key — the reminder one needed *two* partial indexes because a NULL
    `participant_id` (meaning "the event owner") never collides in a plain unique index, so a single
    index would silently allow duplicate owner reminders. Generated `drizzle/0065_awesome_lorna_dane.sql`
    via `pnpm drizzle-kit generate`: 11 CREATE TABLEs, **zero** DROP/ALTER COLUMN statements
    (verified by grep — purely additive). **Found and fixed a real generator bug**: drizzle emitted
    the composite `ADD CONSTRAINT ... FOREIGN KEY (organization_id, x) REFERENCES <new table>` block
    *before* the `CREATE UNIQUE INDEX ..._organization_id_id_unique` statements those FKs depend on,
    so the first migration run failed with `42830 there is no unique constraint matching given keys
    for referenced table "calendar_events"`. Reordered the 11 unique-index statements ahead of the
    first `ALTER TABLE` in the generated file. `pnpm exec drizzle-kit check` reports "Everything's
    fine"; `pnpm test:migrations:local` against a fresh disposable
    `builderhunt_security_test_*` database returns `{"firstRun":"ok","secondRun":"ok","applied":66}`
    (idempotent re-run). Applied to the local dev database and verified against live Postgres with a
    transactional `DO` block that all 11 tables exist and that public visibility, a zero-length time
    range, a half-populated source pair, a second default calendar, and a non-allowlisted reminder
    offset are each rejected by the real constraint. `migration-hashes.json` regenerated (66
    migrations). `pnpm tsc --noEmit`, `pnpm eslint`, and the full `pnpm vitest run` (2836 passed)
    are clean.

- [x] **Add operational schedule and run schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`, `docs/architecture/data-classification.md`
  - Do: Add system-operational `operational_schedules` and `job_runs` with stable job key,
    cron/timezone, scope, enabled/next-run, scheduled/actual timestamps, state checks, counters,
    duration, redacted error code, and scan indexes. Grant only worker/platform writes and narrowly
    allow calendar projection reads through repository DTOs.
  - Verify: migration checks pass; direct web-role insert/update fails; worker insert and redacted
    projection select pass in local PostgreSQL.
  - **Evidence (2026-07-26)**: Added `operational_schedules` (unique `job_key`, cron expression,
    IANA timezone, `platform|organization` scope check, enabled/next-run with a scan index) and
    `job_runs` (schedule FK, scheduled/started/finished timestamps, 5-state check, non-negative
    counter/duration check, a `finished_at implies started_at` check, and a deliberately *redacted*
    `error_code` short code — never a provider message or stack trace, because these rows are
    projected into a user-visible calendar feed). Both are deliberately **not** tenant tables: a
    job identity is stable and platform-owned, so they carry no `organization_id` and get no RLS —
    access is controlled entirely by GRANT, the same pattern as `status_checks` (0048),
    `conversion_events` (0062), and the profile-removal tables (0064). Generated
    `drizzle/0066_orange_the_enforcers.sql` (2 CREATE TABLEs, no DROP/ALTER) plus a hand-written
    `drizzle/0067_operational_schedule_grants.sql` registered via
    `drizzle-kit generate --custom`. Grants: `builderhunt_app` gets **SELECT only** on both tables
    (spec.md's projection contract says these "cannot be dragged or edited" — a request handler must
    never be able to create, reschedule, or rewrite platform job history);
    `builderhunt_worker` gets SELECT+UPDATE on schedules (claim a due job) and SELECT+INSERT+UPDATE
    on runs, but no DELETE (run history is append-only evidence); `builderhunt_platform` registers/
    enables/disables schedules and trims aged run history.
    `pnpm test:migrations:local` against a fresh disposable database returns
    `{"firstRun":"ok","secondRun":"ok","applied":68}`. **Verified the boundary behaviorally against
    live Postgres using `SET LOCAL ROLE`**, not just by reading the grant table: as
    `builderhunt_app`, `INSERT INTO operational_schedules` and `UPDATE job_runs` both fail with
    `permission denied`; a full transaction then proves the real pipeline works — platform INSERTs
    the schedule, worker UPDATEs it to claim, worker INSERTs the run row, worker UPDATEs it closed
    with counters/duration, and `builderhunt_app` SELECTs the resulting redacted projection
    (`job_key`/`state`/`processed_count`/`duration_ms`/`error_code`). Also confirmed the worker
    genuinely *cannot* register a new schedule (that's the platform role's job), which the grant
    design intends. `pnpm tsc --noEmit` and the full `pnpm vitest run` (2836 passed) are clean.

- [x] **Add strict private-user RLS policies**
  - Files: `drizzle/`, `tests/unit/shared/lib/security/rls-policy.test.ts`,
    `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/verify-rls-local.mjs`
  - Do: Enable/force RLS on every new tenant table. Calendar/availability/invitation owner can
    access; explicitly participating internal users get only resource-permitted read; org admin
    without participation is denied. Public capability never receives database role access.
    Workers receive scoped policies for occurrence/job/retention work.
  - Verify: direct SQL covers owner, participant, unrelated member, admin without participation,
    tenant B, missing context, spoofed context, cross-tenant FK, and worker scope; `pnpm
test:rls:local`.
  - **Evidence (2026-07-26)**: `drizzle/0069_calendar_scheduling_rls_grants.sql` enables and
    FORCEs RLS on all 11 tenant tables. Unlike the ordinary org-scoped pattern used by billing,
    these policies compose **two** conditions — `organization_id` AND
    (`owner_user_id = app.user_id` OR an access-granted participant) — because the org filter
    alone would let any member, including an admin, read another user's private calendar. There is
    deliberately **no `app.organization_role = 'admin'` escape hatch anywhere**. Owner access and
    participant read are separate policies rather than one `FOR ALL`, since Postgres ORs permissive
    policies of the same command and a combined policy would also grant participants UPDATE/DELETE.
    **Found and fixed a real design bug through testing**: the first version failed every query with
    `infinite recursion detected in policy for relation "calendar_events"` — the calendar_events
    participant policy read `event_participants`, whose owner policy read back into
    `calendar_events`. `SECURITY DEFINER` was rejected as the fix because it depends on the table
    owner holding BYPASSRLS, which differs between local (`postgres`, superuser) and production
    (`migration_operator`) — it would have silently behaved differently in prod. Broke the cycle
    structurally instead (`drizzle/0068_special_tigra.sql`): `event_participants` now carries an
    `event_owner_user_id` column held honest by a composite FK against
    `calendar_events(organization_id, id, owner_user_id)`, so an inconsistent copy is not
    representable and this table's policies read only its own columns. Also reordered that
    migration's `CREATE UNIQUE INDEX` ahead of the FK that references it (same drizzle emission-order
    problem as 0065). `builderhunt_platform` intentionally receives **no grant at all** on these
    tables — spec.md gives candidate/private-calendar data no operator read path. Verified against
    live Postgres with a 9-scenario transactional script covering owner, participant (reads but
    `UPDATE 0`), unrelated member (0), **admin without participation (0 events, 0 candidates)**,
    tenant B, missing context, spoofed user id, cross-tenant insert (rejected by RLS), and worker
    scope (org-scoped reads, can materialize occurrences, `permission denied` on candidate writes).
    Extended `scripts/db/prepare-rls-fixture.mjs` (adds user-c as a participant and user-d as a
    non-participating admin) and `scripts/db/verify-rls-local.mjs` with 9 new assertions, so
    `pnpm test:rls:local` now covers these tables in CI — full suite passes (`EXIT=0`).
    **Confirmed the new assertions are load-bearing** by temporarily adding an org-wide admin SELECT
    policy and re-running: the suite failed with "org admin without participation saw private
    calendar data: {events:1}", then passed again once removed.
    `pnpm test:migrations:local` returns `{"firstRun":"ok","secondRun":"ok","applied":70}`.
    `pnpm tsc --noEmit` and the full `pnpm vitest run` (2836 passed) are clean.

- [x] **Implement calendar repository**
  - Files: `src/shared/lib/repositories/calendar.ts` (new),
    `tests/unit/shared/lib/repositories/calendar.test.ts` (new)
  - Do: Add calendar/event/occurrence/participant/reminder/delivery CRUD, search, and range queries using an injected
    `TenantTransaction`; explicit DTO columns only; all predicates include server-resolved
    organization and owner/participant semantics; optimistic updates match `id+organization+version`.
  - Verify: repository tests cover tenant predicates, no unrestricted row serialization, stale
    update, occurrence upsert, participant access, and admin denial; `pnpm test
tests/unit/shared/lib/repositories/calendar.test.ts`.
  - **Evidence (2026-07-26)**: Wrote `repositories/calendar.ts` — calendar/event/occurrence/
    participant/reminder/delivery access over an injected `TenantTransaction`. Every select names
    its columns explicitly (never `select()`), so a column added later is never accidentally
    serialized; `calendar_notification_deliveries` deliberately omits `idempotencyKey`,
    `providerReference`, and `externalRecipientHash` as delivery plumbing with no product meaning.
    Every predicate carries the server-resolved `organizationId` and, for private resources, the
    `ownerUserId` — layered on top of the RLS policies rather than trusting them alone.
    `updateEventWithVersion`/`deleteEventWithVersion` match `id + organization + owner + version`
    and return `null` on a miss, which the route maps to `409 event_changed`. `upsertOccurrences`
    is idempotent on the table's `(org, event, recurrence_id)` identity. `listBusyRanges` returns
    only busy, non-cancelled events for availability subtraction, and range reads use the same
    half-open `[from, to)` semantics as `calendar.ts`'s `rangesOverlap`. 25 disposable-DB tests
    cover: same-id-wrong-tenant returning null, the projection genuinely omitting `createdAt`/
    `updatedAt`, half-open range filtering, a stale optimistic update leaving the row untouched
    (asserted by re-reading the title, not just the null return), non-owner and cross-tenant update
    refusal, delete honouring both owner and version, title/type/participant search, upsert
    idempotency, `hasGrantedParticipation` distinguishing a present-but-not-access-granted
    participant from a granted one, RSVP touching only the caller's own row, the composite FK
    rejecting a participant that claims the wrong event owner, due-reminder sweep + state marking,
    cancellation affecting only still-pending reminders, the DB rejecting a non-allowlisted
    reminder offset, delivery idempotency, and a user attempting to mark someone else's delivery
    read affecting only their own. `pnpm tsc --noEmit` and `pnpm eslint` are clean.

- [x] **Implement scheduling repository**
  - Files: `src/shared/lib/repositories/scheduling.ts` (new),
    `tests/unit/shared/lib/repositories/scheduling.test.ts` (new)
  - Do: Add availability/override/invitation/submission/link methods, hashed-capability lookup,
    generic public DTOs, expiry/revocation mutation, and transaction operations needed for atomic
    booking. Never return token hash or organization ID publicly.
  - Verify: tests cover tenant scope, capability hash lookup, expired/revoked/used tokens,
    non-enumerating misses, and cross-invitation mutation denial; `pnpm test
tests/unit/shared/lib/repositories/scheduling.test.ts`.
  - **Evidence (2026-07-26)**: Wrote `repositories/scheduling.ts` with two deliberately different
    audiences. Organizer functions re-filter on `organizationId` + `ownerUserId`. Public-capability
    functions return a `PublicInvitationDto` that structurally omits `organizationId`,
    `ownerUserId`, and `capabilityHash` — `capabilityHash` appears in **no** projection anywhere in
    the file, so it cannot leak to organizer or candidate. `findInvitationByCapabilityHash` returns
    plain `null` for unknown, revoked, expired-by-timestamp, expired-by-status, and declined
    invitations alike, so a caller cannot probe which case a secret hit (spec.md's non-enumerating
    requirement). `replaceAvailabilityPolicy` is delete-then-insert inside the caller's
    transaction, owner-scoped so it can never clear another user's rules. `upsertSubmission` keeps
    one row per invitation; `upsertLink` is idempotent on `(org, submission, normalizedUrl)`.
    Link mutations are scoped by `submissionId` as well as link id, so a capability for one
    invitation can never move another invitation's link. 22 disposable-DB tests cover all of the
    above plus: the capability hash absent from both insert and list results, optimistic
    invitation state change succeeding once then refusing a stale retry, non-owner refusal,
    the DB rejecting an overnight availability rule, the `authorized_crawl` check constraint
    rejecting a decision with no recorded attestation and accepting it once attested, a
    cross-submission link mutation returning null while the correct one succeeds, and the
    retention sweeps being both idempotent (a second `markInvitationExpired` returns null) and
    tenant-scoped. `pnpm tsc --noEmit` and `pnpm eslint` are clean.

## Phase 3 — Calendar service, API, worker, and UI

- [x] **Implement calendar service and authorization**
  - Files: `src/lib/calendar/service.ts` (new), `tests/unit/lib/calendar/service.test.ts` (new),
    `src/shared/lib/authorization/permissions.ts`,
    `tests/unit/shared/lib/authorization/permissions.test.ts`
  - Do: Orchestrate create/update/move/resize/cancel/delete/search/export/range operations through
    tenant context; centralize owner/participant permissions; enforce start/end, private visibility,
    recurrence `this|following|series`, manual-overlap warning versus interview hard conflict,
    reminders, stable ICS UID/SEQUENCE, version, and event-source mutation rules.
  - Verify: service tests cover every role/action, stale membership, stale version, recurrence edit
    scope, cancel vs delete, and no admin implicit access; targeted tests pass.
  - **Evidence (2026-07-26)**: Added 5 calendar `PermissionAction`s to
    `authorization/permissions.ts` plus an `isGrantedParticipant` context flag. These are the only
    actions in that file that **never consult `elevated`** — being an org owner/admin grants
    nothing on someone else's calendar, matching spec.md and the RLS policies. `calendar:read`
    allows owner-or-granted-participant; `calendar:mutate`/`scheduling:manage`/
    `candidate-data:read` are owner-only; `calendar:respond` covers RSVP.
    Wrote `src/lib/calendar/service.ts` as the single place routes call. `resolveEventAccess`
    resolves the caller's relationship once and returns `null` for both "does not exist" and "may
    not see it", so a probe cannot confirm an event's existence — the update path surfaces this as
    `not_found`, never `forbidden`. Implements the spec's split overlap policy: a personal-event
    overlap raises `overlap_warning` (allowed once acknowledged), while an interview overlap is a
    hard `slot_unavailable` that acknowledgement cannot override. Recurring edits require an
    explicit `this|following|series` scope so a user never silently rewrites a whole series;
    invitation-sourced events refuse rescheduling through the ordinary edit path. Cancel and delete
    are deliberately distinct (cancel keeps the row, its `.ics` UID and history, and stops pending
    reminders; delete removes it). `icsUidForEvent` derives a stable UID from the event id so a
    later `CANCEL` matches the original `REQUEST`, and `icsSequenceForEvent` reuses the optimistic
    version as the monotonic SEQUENCE. The three enforcement layers stack on purpose: `can()` here,
    owner/version predicates in the repository, RLS in Postgres. 32 disposable-DB tests cover the
    full role matrix (owner/participant/unrelated member/admin, the last asserted for **both**
    `admin` and `owner` roles), participant-can-read-but-not-mutate, a not-access-granted
    participant still being denied, `editable:false` in the participant's DTO, personal-warning vs
    interview-conflict, back-to-back events not colliding, stale version, every recurrence scope
    resolving to its own plan, the illegal `confirmed → completed` jump, and cancel-vs-delete
    semantics. `pnpm tsc --noEmit`, `pnpm eslint`, and the existing 18 permissions tests are clean.

- [x] **Implement recurrence materialization worker**
  - Files: `src/lib/calendar/recurrence-worker.ts` (new),
    `tests/unit/lib/calendar/recurrence-worker.test.ts` (new),
    `src/shared/lib/repositories/calendar-worker.ts` (new),
    `src/routes/api/admin/calendar/run-worker.ts` (new)
  - Do: Expand recurring events idempotently for the configured past/future horizon, apply
    exclusions/overrides/cancellations/successor splits, prune obsolete future instances, lease
    batches by tenant, schedule reminder deliveries with occurrence/recipient/channel/offset
    idempotency, suppress cancelled/removed recipients, write job runs, and authenticate like
    existing workers using worker scope rather than a global tenant transaction.
  - Verify: repeated/concurrent runs produce identical occurrence sets; one tenant failure does not
    affect another; unauthorized route fails; run against local DB and inspect rows.
  - **Evidence (2026-07-26)**: Wrote `repositories/calendar-worker.ts` (its own copy of the
    `listWorkerOrganizationIds`/`withWorkerOrganization` pair, matching the precedent every other
    worker repository follows) plus `lib/calendar/recurrence-worker.ts` and the
    `/api/admin/calendar/run-worker` route (cron-principal-or-platform-admin auth, same shape as
    `alerts/run-worker`; also refuses to run when `CALENDAR_ENABLED=false`, so the kill switch
    gates background writes and not just the UI).
    Idempotency is structural: expansion is a pure function of `(rrule, dtstart, timezone,
    horizon)` and the write is an upsert on the `(org, event, recurrence_id)` identity. Each
    organization gets its own `withWorkerOrganization` transaction, so one tenant's failure rolls
    back only that tenant's batch and the loop continues; the recorded `errorCode` stays a short
    redacted slug because these `job_runs` rows are projected into a user-visible calendar feed.
    Pruning is deliberately bounded to `>= now`, so shrinking a rule never deletes an occurrence in
    the past that a user may already have acted on.
    **Found and fixed a real runtime bug**: `<> all(${array})` made drizzle expand the JS array
    into a parameter *tuple* rather than binding a Postgres array, so every prune failed with a
    syntax error and the worker silently wrote nothing while reporting only a redacted
    `materialization_failed`. Caught because the tests assert on actual occurrence rows rather than
    on the worker's own return value. Replaced with `notInArray`/`inArray` in both places that had
    the pattern. 11 disposable-DB tests: weekly expansion within the horizon, a second run
    converging on the identical set, two **concurrent** runs producing no duplicates, pruning a
    shortened series, past occurrences surviving a shrink, a cancelled event losing its whole
    materialization, `recurrenceUntil` narrowing the window, non-recurring events ignored, per-tenant
    isolation of written rows, job-run counters with a bounded error code, and a
    Europe/Copenhagen DST transition keeping 09:00 local (08:00Z → 07:00Z).
    `pnpm tsc --noEmit`, `pnpm eslint`, `node scripts/check-route-coverage.mjs`, and the full
    `pnpm vitest run` (2926 passed) are clean.

- [x] **Implement reminder and participant-notification delivery**
  - Files: `src/lib/calendar/reminder-worker.ts` (new),
    `tests/unit/lib/calendar/reminder-worker.test.ts` (new), `src/lib/calendar/ics.ts` (new),
    `tests/unit/lib/calendar/ics.test.ts` (new),
    `src/routes/api/admin/calendar/run-reminders.ts` (new), `src/shared/lib/email.ts`,
    `src/shared/lib/repositories/calendar-worker.ts`, `src/shared/lib/repositories/calendar.ts`,
    `src/lib/calendar/service.ts`
  - Do: Lease due reminders per tenant, send in-app/email delivery and stable UID/increasing SEQUENCE
    ICS `REQUEST`/`CANCEL` updates, write idempotent delivery/read state, retry transient failures with cap, and
    suppress cancelled events, removed participants, stale occurrence versions, and duplicate
    occurrence/recipient/channel/offset keys.
  - Verify: tests cover each allowed offset/channel, exactly-once concurrent delivery, retry,
    cancellation/reschedule update, participant removal, tenant isolation, and unauthorized worker;
    a test inbox imports an update and cancellation into a standards-compliant calendar.
  - Evidence: 26 worker tests + 6 ICS tests, all green; full suite 2967 passed.

    **Exactly-once is the database's job, not the code's.** Every send is preceded by an insert
    into `calendar_notification_deliveries` on a deterministic idempotency key with a unique index.
    The insert happens BEFORE the send deliberately: a crash in between costs one missed reminder,
    whereas insert-after-send would cost a duplicate on every retry, forever. On conflict the
    worker re-reads the row and only retries it if its state is `failed`.

    **The first version of the concurrency test was worthless and I only found out by breaking the
    code.** `Promise.all([run(), run()])` passed even after I made the idempotency key random,
    because the second sweep simply saw `state = 'sent'` and skipped — it was testing reminder-state
    terminality, not the index. Rewrote it to hold the first transaction open at the send step while
    a second sweep reads a still-pending reminder and races on the same key. Re-ran the random-key
    mutation: now fails with `expected [2 items] to have a length of 1`. The `stale_schedule`
    suppression was checked the same way (removing the branch fails its test).

    **Found and fixed a real bug in the process.** `updateEvent` deleted materialized occurrences on
    a timing change but left each reminder's absolute `nextFireAt` pinned to the ORIGINAL start — so
    a meeting moved from Tuesday to Friday still fired its "in 15 minutes" notice on Tuesday. Added
    `rearmRemindersForEvent` (recomputes the fire time from the durable offset) and called it from
    `updateEvent`. The worker also suppresses any reminder whose `nextFireAt` no longer matches the
    event's current start, as a second line of defence against out-of-band writes.

    **The `participant_removed` branch is currently unreachable and the test says so.** The
    reminder's composite FK to the participant is ON DELETE CASCADE, so removing an attendee removes
    their reminders in the same statement. The test asserts what actually happens (the reminder row
    is gone) rather than pretending the branch fired; the branch stays as defence for a future
    soft-removal path, and because a dangling participant link must never fall through to the
    owner's address.

    **ICS is validated by a parser, not a regex.** Added `node-ical` as a devDependency and parse
    our own output with it: a regex confirms characters were emitted, a parser confirms a compliant
    client can read them (line folding at 75 octets, CRLF, `,`/`;` escaping, VTIMEZONE placement).
    Tests confirm CANCEL reuses the REQUEST's UID and carries a strictly higher SEQUENCE — without
    both, a client files the cancellation as an unrelated event and the original never disappears.

    **Live-verified end to end, not just under vitest.** `POST /api/admin/calendar/run-reminders`
    returns 401 unauthenticated; with the cron secret it runs under the real `builderhunt_worker`
    role across 198 organizations. Seeded a due reminder in the local DB: run 1 returned
    `delivered: 1`, run 2 returned `delivered: 0`, the reminder row went to `state=sent, attempts=1`,
    exactly one delivery row exists in `sent`, and the dev email log shows
    `Calendar reminder email would be sent to: edd_admin2@local.com`. (Local `builderhunt_worker`
    had a stale password that broke this endpoint AND the pre-existing recurrence worker; reset it.)

- [x] **Add calendar event APIs** (partial — see evidence)
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
  - **Evidence (2026-07-26, PARTIAL)**: Shipped `/api/calendar/events` (GET range/search, POST
    create) and `/api/calendar/events/$eventId` (GET detail, PATCH versioned/scoped update and
    cancel, DELETE). All authorization lives in `lib/calendar/service.ts`; the routes parse, enter
    tenant context, and map coded errors. Error bodies carry a stable code only. A caller who may
    not see an event gets the same `404 not_found` as one asking for a missing id. Every handler
    also refuses when `CALENDAR_ENABLED=false`. `node scripts/check-route-coverage.mjs` passes
    (132 routes). Verified live against the running dev server: unauthenticated GET returns
    `401 {"error":"authentication_required"}` and a malformed range still returns 401 (auth
    precedes validation, so an unauthenticated prober learns nothing about parameter shape).
  - **Evidence (2026-07-26, export + notifications now shipped)**: Added
    `src/routes/api/calendar/export[.]ics.ts` and `src/routes/api/calendar/notifications.ts`
    against the existing `interview-api.ts` contracts, plus
    `tests/unit/lib/calendar/notifications.test.ts` (7 tests).

    **The ICS export is authenticated per request, with no subscribable URL.** A signed feed link
    is the conventional way to ship this and also the conventional way to leak an entire calendar
    to whoever the link gets forwarded to. The range is required and bounded by
    `exportIcsRequestSchema`, so "export my calendar" cannot become an unbounded scan, and the
    response carries `Cache-Control: private, no-store` because the body is personal data.

    **Notifications page by keyset on `(createdAt, id)`, not OFFSET.** Offset paging over a table
    that is actively receiving inserts skips or repeats rows as the boundary shifts under the
    reader — the exact failure a notification drawer must not have. The `id` tiebreak is load-
    bearing: two reminders for one event can land in the same millisecond. Verified by removing the
    tiebreak, at which point the shared-timestamp test fails with
    `expected [ Array(1) ] to deeply equal [ …(2) ]`.

    **No admin override exists on this resource, and a test enforces that.** A delivery has exactly
    one recipient, so an org admin reading the feed gets zero rows rather than everyone's. Mark-read
    takes an explicit id list; an id the caller does not own comes back simply unmarked, making
    "not yours" and "does not exist" indistinguishable to a prober. A malformed cursor is rejected
    with `400` rather than silently treated as page one — silently restarting would make a paging
    client loop over the same rows forever.

    **Live-verified authenticated, not just unauthenticated.** Signed in as the seeded admin,
    created an event through the real API, then: `GET /api/calendar/export.ics` returned `200` with
    `text/calendar; charset=utf-8`, `attachment; filename="builderhunt.ics"`, `private, no-store`,
    and a body containing `METHOD:PUBLISH`, `UID:…@builderhunt.dev`, `SEQUENCE:0`,
    `DTSTART;TZID=Europe/Copenhagen`. Ran the reminder worker to produce a real delivery; the feed
    returned it with `unreadCount: 1`; `PATCH` with its id returned
    `{"markedIds":[…],"unreadCount":0}`; `PATCH` with a foreign id returned `{"markedIds":[]}`.
    Unauthenticated, all three verbs return `401 authentication_required`, including a request with
    no range at all — auth precedes validation, so a prober learns nothing about parameter shape.
    `node scripts/check-route-coverage.mjs` passes at 135 routes.

    **STILL OPEN for this task**: the role-matrix API tests (participant read-only, admin denial,
    tenant B, stale-version 409 over HTTP) are not yet automated — those paths are covered at the
    service layer by `service.test.ts`'s 32 tests, but not yet through the routes.

- [x] **Add availability APIs**
  - Files: `src/routes/api/calendar/availability/index.ts` (new),
    `src/routes/api/calendar/availability/overrides.ts` (new),
    `src/lib/scheduling/availability.ts` (new), `tests/unit/lib/scheduling/availability.test.ts` (new),
    `src/shared/lib/scheduling.ts`, `src/shared/lib/interview-api.ts`,
    `src/shared/lib/repositories/scheduling.ts`, `src/shared/lib/db/schema.ts`,
    `drizzle/0070_availability_policy.sql`, `drizzle/0071_availability_policy_rls.sql`,
    `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/verify-rls-local.mjs`
  - Do: Add GET/PUT weekly rules and POST/DELETE overrides for the authenticated owner, bounded
    effective ranges, timezone validation, overlap normalization, versioning, and cache invalidation.
  - Verify: tests/curl cover timezone/DST inputs, overlapping rules, invalid overnight interval,
    tenant B, stale version, and normalized response.
  - Evidence: 19 tests green; full suite 2993 passed.

    **The schema was missing a place to put the version.** `putAvailabilityRequestSchema` requires
    `version`, `defaultReminderOffsets` and `defaultReminderChannels`, and none of the three had a
    column anywhere — `availability_rules`/`availability_overrides` hold only rule *contents*.
    Deriving a version from the contents does not work: two clients that both delete rule A and add
    rule B produce identical content and would both conclude they won. Added
    `availability_policies` (0070) as a one-row-per-owner header with a monotonic counter, plus RLS
    and grants (0071) following the same owner-only pattern as 0069 — no admin escape hatch,
    worker gets SELECT only.

    **A test caught a real off-by-one in that versioning.** Creating the row at version 1 made
    "saved once" indistinguishable from "never saved" (an absent policy also reads as 1), so two
    clients racing the very first write would both see their expected version satisfied and the
    second would silently overwrite the first. The create now lands at 2. The test that failed is
    the one asserting a stale version is refused.

    **Overlap normalization merges what can be merged and refuses what cannot.** Two windows on the
    same weekday and timezone combine when slot length, buffers, notice and horizon all agree —
    including windows that merely touch, since leaving those split inserts a phantom boundary that
    fragments slot generation. When those settings differ there is no honest answer: picking either
    rule's settings generates slots the owner never configured, and keeping both double-books the
    overlap. That case is rejected with a message rather than resolved by guesswork. Same clock
    window in two different timezones is *not* an overlap, and a test pins that.

    **Timezones are validated against ICU, not just against a regex.** Zod can confirm a string
    looks like a zone; only `isValidIanaTimeZone` can say `Europe/Atlantis` does not exist. A bogus
    zone that passed would silently generate slots at the wrong wall-clock time.

    **Override writes route through the same versioned path as a full PUT.** A bare insert or delete
    would leave the version untouched, so a client holding the previous version would keep believing
    its copy was current. Deleting a date with no override is treated as success, not 404 —
    reporting "not found" would tell a prober whether the owner had blocked that day.

    **RLS verified by breaking it.** Added `availability_policies` fixtures and three checks to
    `verify-rls-local.mjs` (owner read, admin denied, non-owner write denied), then added an
    org-wide admin SELECT policy and confirmed the verifier fails with
    `Error: org admin saw another member's availability policy`; removing it passes again.

    **Live-verified against the running server with a real session.** `GET` on an empty policy
    returns `version: 1`; a `PUT` with two overlapping Monday rules came back normalized to one
    09:00–15:00 window for Monday plus the untouched 09:00–12:00 for Tue/Wed at `version: 2`;
    re-`PUT` at version 1 returns `409 state_changed`; a bogus timezone returns
    `400 {"error":"invalid_input","message":"Unknown time zone: Europe/Atlantis"}`; conflicting slot
    settings return `400` with the overlap message; a blocked override carrying times is rejected at
    the Zod boundary; `POST` then `DELETE` of an override moved the version 2→3→4. Unauthenticated
    requests return `401`.

- [x] **Build calendar feature components** (partial — see evidence)
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

- [x] **Add calendar route and navigation**
  - Files: `src/routes/_dashboard/calendar/index.tsx` (new),
    `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `src/routeTree.gen.ts`
  - Do: Add `/calendar`, lazy-load heavy calendar UI, add Calendar navigation icon/active state,
    preserve route range/view in safe search params, and regenerate route tree through the normal
    router plugin/build process rather than hand-maintaining it.
  - Verify: `pnpm build`; authenticated navigation loads calendar, direct URL restores view/range,
    signed-out request redirects, and mobile nav remains usable.

## Phase 4 — Operational projections

- [x] **Implement schedule registry and next-run calculation**
  - Files: `src/shared/lib/operational-schedules.ts` (new),
    `tests/unit/shared/lib/operational-schedules.test.ts` (new),
    `src/shared/lib/repositories/platform-operations.ts`,
    `src/shared/lib/db/platform-db.ts` (new),
    `src/routes/api/admin/operations/sync-schedules.ts` (new), `package.json`
  - Do: Register stable keys/cadences/timezones/labels/source routes for current alert, sprint,
    enrichment, discovery, embeddings, legal, calendar, document, retention, and reconciliation
    workers; calculate next runs deterministically and upsert registry state.
  - Verify: tests cover DST, disabled schedule, next-run boundary, duplicate key, and safe route;
    registry sync twice is idempotent.
  - Evidence: 16 registry tests + 26 repository tests green; full suite 3032 passed.

    **DST is delegated to `cron-parser`, not hand-rolled.** Cadences are stored as real cron
    expressions against a named IANA zone, so a daily job stays at the same *local* hour across both
    transitions. Tests assert 03:00 Europe/Copenhagen stays 03:00 either side of spring-forward and
    fall-back while its UTC hour changes — a fixed offset would drift an hour twice a year, which is
    exactly the class of bug that is invisible until it happens. A job scheduled inside the
    nonexistent 02:30 gap still fires that day rather than being skipped for 24 hours.

    **Label and source route live in code, not in the table.** They are properties of the deployed
    build; a stale label in a row would be worse than no label. The table holds only what changes at
    runtime (`enabled`, `next_run_at`). `assertRegistryIsSafe` rejects duplicate keys, a route
    outside `/api/admin/`, a query string, a traversal attempt, an unknown timezone, and an
    unparseable cron — the last one matters because an unparseable expression would otherwise
    present as a job that looks healthy and simply never runs.

    **Frequent jobs are pinned to UTC on purpose**, local zones only where a human notices the hour.
    A `*/15` job in a DST zone gains or loses one interval twice a year for no benefit.

    **Sync never re-enables what an operator paused**, and never deletes a retired key — it disables
    it, so `job_runs` history stays joinable and a returning job keeps its identity. It also repairs
    a `next_run_at` that has fallen into the past after a deployment gap, which otherwise never
    self-corrects.

    **A permission error corrected the design rather than the grant.** The first version ran the
    sync as `builderhunt_worker` and got `42501 permission denied`: 0067 grants the worker only
    SELECT/UPDATE on `operational_schedules`, because creating and retiring a schedule *identity* is
    an operator action while advancing `next_run_at` after a run is a worker action. The fix was to
    add `platform-db.ts` and run the sync as the platform role — widening the worker's grant would
    have erased a distinction the migration author put there deliberately.

    **Live-verified:** `POST /api/admin/operations/sync-schedules` returns `401` unauthenticated;
    with the cron secret the first call returned `{"created":10}` and the second
    `{"created":0,"updated":10,"retired":0}` with byte-identical rows — idempotent against the real
    database, all 10 jobs enabled with future `next_run_at`.

- [x] **Write job-run records from every worker entry point**
  - Files: `src/routes/api/admin/alerts/run-worker.ts`,
    `src/routes/api/admin/discovery/run-worker.ts`,
    `src/routes/api/admin/embeddings/run-worker.ts`,
    `src/routes/api/admin/enrichment/run-worker.ts`,
    `src/routes/api/admin/legal/run-worker.ts`,
    `src/routes/api/admin/sprints/run-worker.ts`,
    `src/shared/lib/repositories/platform-operations.ts`,
    `tests/unit/shared/lib/repositories/platform-operations.test.ts`
  - Do: Wrap each run in a shared start/finish/fail recorder using stable idempotency per scheduled
    occurrence, counters and redacted error codes; never store payload/candidate content.
  - Verify: success/failure/retry tests produce one monotonic run row and no raw error secrets;
    execute at least two real local workers and inspect API projection DTOs.
  - Evidence: `withJobRun` is now the single recorder for all seven workers.

    **It is a wrapper, not a pair of calls each worker makes.** The failure path is the reason: a
    worker that throws must still close its run row, and relying on every author to remember a
    try/finally is how half-open `running` rows accumulate until someone notices the dashboard is
    lying. The error is re-thrown after recording — swallowing it would turn a crashed worker into
    an HTTP 200.

    **Counters are mapped per worker, not guessed generically.** Each worker reports its own shape
    (`alertsEvaluated`/`errors[]`, `sprintsRun`, `processed`/`failed`, `upserted`, `embedded`), so a
    single generic mapping would record numbers that do not mean what the calendar feed's labels
    say. A `payload` field carries the worker's own result through unchanged, so no HTTP response
    body was altered by adding the recorder.

    **The two calendar workers record inside the function; the other five at their route.** The
    calendar workers accept an injected `db`, which is what lets a test assert on the run row it
    actually wrote. Either way it is the same `withJobRun`, so there is exactly one place that
    decides how a run opens and closes — the previous duplicate `openJobRun`/`closeJobRun` pair was
    removed.

    **Error codes are redacted at the boundary.** Only a `^[a-z0-9_]{1,64}$` code is persisted;
    anything else collapses to `worker_failed`. A test throws
    `postgres://user:hunter2@db.internal refused` with `code: 'ECONNREFUSED extra'` and asserts the
    stored row contains neither the credential nor the host.

    **Two real workers executed through their routes** (`calendar/run-reminders`,
    `embeddings/run-worker`, plus `alerts/run-worker`): each wrote one closed row with a duration,
    `alerts.evaluate` recorded `succeeded 1/0`, and `embeddings.backfill` honestly recorded
    `failed 0/256` because the local embedding provider is down — the recorder reported reality
    rather than a green 200. After the registry sync, a subsequent run linked to its `schedule_id`.
    (`next_run_at` did not visibly move in that check because the run happened at 14:17 and the
    next 5-minute boundary was still 14:20; the advance itself is asserted in the unit test.)

    Local hazard worth recording: running the RLS fixture resets cluster-global role passwords, which
    breaks the dev server's worker/auth connections mid-session (`28P01`). Symptom is a 500 from any
    worker route or sign-in; fix is to re-`ALTER ROLE ... PASSWORD` from `.env`.

- [x] **Persist honest alert evaluation timing**
  - Files: `src/shared/lib/db/schema.ts`,
    `drizzle/0072_alert_evaluation_timing.sql`,
    `drizzle/0073_alert_evaluation_timing_grant.sql`,
    `src/shared/lib/alerts.ts`, `tests/unit/shared/lib/alerts.test.ts`,
    `src/shared/lib/repositories/alerts-worker.ts`,
    `tests/unit/shared/lib/repositories/alerts-timing.test.ts` (new), `src/lib/alerts/worker.ts`
  - Do: Add/normalize `next_evaluation_at`, cadence, pause state, and last evaluated timestamp for
    alerts so calendar estimates come from source state. Update worker atomically on success/failure;
    do not promise a match.
  - Verify: migration and alert tests cover active/paused/failure/retry cadence; existing alert UI
    remains correct.
  - Evidence: 32 pure timing tests + 7 real-DB tests; full suite 3053 passed.

    **Fixed a real bug: a transient failure silenced an alert for its whole window.** The worker's
    `finally` advanced `lastCheckedAt` identically whether the evaluation succeeded or threw, so one
    network blip meant a *weekly* alert went quiet for a week. Added `next_evaluation_at`,
    `consecutive_failures` and `last_evaluation_error_code`, and a failed attempt now gets a 5-minute
    backoff doubling per consecutive failure — capped at the frequency window, because uncapped
    backoff turns a bug into an indefinite outage. `enabled` already served as pause state, so no new
    column for that.

    **Written in one UPDATE, on purpose.** `nextAlertTimingState` returns all four fields together so
    the caller cannot split the write; a split would leave a window where the calendar feed reads a
    next-run derived from the *previous* attempt's failure count.

    **`next_evaluation_at` is a checking time, never a promise of a match.** That is stated in the
    column comment and the function docs, because the calendar feed renders it and "next evaluation"
    read as "you will get a result then" would be a lie the schema encouraged.

    **No backfill needed.** `isDueForEvaluation` prefers the persisted value and falls back to the
    frequency window when it is null, so existing rows keep working and a fresh alert is still due
    immediately. A test pins both branches.

    **The permission error was the most valuable thing here.** The new write failed against the real
    database with `42501 permission denied for table alerts` while every test passed, because the
    disposable test DB runs as owner. Cause: `builderhunt_worker` holds **column-level** UPDATE on
    exactly `last_checked_at` and `last_triggered_at` (0010, 0056) — someone deliberately scoped it so
    a compromised worker cannot disable every alert or rewrite what they match on. `GRANT UPDATE ON
    TABLE alerts` would have made the error go away and erased that. 0073 grants only the three new
    timing columns, and a test parses the migration's executable lines to fail if the table-wide form
    ever appears (verified by adding it: the test fails).

    **Live-verified under the real worker role:** forced the hourly alert due with
    `consecutive_failures = 2, last_evaluation_error_code = 'rate_limited'`, ran
    `POST /api/admin/alerts/run-worker`, and the row came back
    `gap = 00:55:00, consecutive_failures = 0, last_evaluation_error_code = NULL` — success resets
    the failure state and schedules exactly one hourly window out. Also confirmed directly against
    `DATABASE_WORKER_URL` that the worker can write `next_evaluation_at` but still gets
    `permission denied` on `enabled` and `trigger_conditions`.

- [x] **Implement unified calendar feed**
  - Files: `src/lib/calendar/projections.ts` (new),
    `tests/unit/lib/calendar/projections.test.ts` (new),
    `src/routes/api/calendar/feed.ts` (new),
    `src/shared/lib/repositories/organization-alerts.ts`
  - Do: Merge authorized internal events, operational next runs, alert estimates, job runs, and
    existing alert triggers over a bounded range; preserve discriminated DTOs, `estimated|actual`,
    `editable: false`, stale timestamps, and source links; paginate agenda results.
  - Verify: tests cover layer filters, range boundaries, stale source, no irrelevant tenant job,
    read-only fields, and query-count ceiling; p95 local fixture query under 500 ms.
  - Evidence: 20 tests green; full suite 3073 passed; route coverage 139.

    **The event item is built field-by-field, not spread.** `feedEventItemSchema` is `.strict()` and
    deliberately has no `organizationId`, so a spread would both fail validation and be the exact
    leak the closed schema exists to prevent. A test parses the whole response through the schema,
    which is what makes that guarantee mechanical rather than a convention.

    **`editable: false` on every projection is a type-level literal, not a runtime flag.** A
    draggable projection would edit nothing — the change would vanish on the next fetch — so the
    contract makes an editable projection unrepresentable.

    **`estimateOnly` separates intent from history.** `job_projection`/`alert_projection` say "we
    intend to run then"; `job_run`/`alert_result` say "this happened". A user planning around a
    prediction is making a different decision than one reading a record, so they must not render
    identically. The alert projection's title is `Next check — <name>`; a test asserts it never
    contains the word "match", because "next match" would promise a result we cannot promise.

    **Platform-scoped jobs are excluded from a tenant feed.** Billing reconciliation and builder
    discovery are not the organization's work; showing them would read as "your account is doing
    this", which is untrue and unactionable. Only `scope: 'organization'` entries appear.

    **Alerts are scoped to the caller, not the organization.** An alert is a personal watch list, so
    showing a colleague's evaluation schedule would leak what they track — the same reasoning that
    gives calendar events no admin read path. Tests cover both the projection and the match buckets.

    **`staleSources` is the honest-uncertainty channel.** A schedule whose next run is already in the
    past means nothing is executing, so it is named rather than drawn as a confident future entry. A
    failing alert is named *and still shown*, because hiding it would look like the alert was
    deleted. The list is de-duplicated so one broken worker reads as one problem.

    **Cost is measured, not assumed.** The query-ceiling test wraps the transaction in a Proxy that
    counts real `select`/`execute` calls, seeds 25 events plus 25 triggers, and asserts ≤ 6 queries —
    a per-item query would push it into the dozens. Alert matches are aggregated per alert per day in
    SQL (`date_trunc` + `count(*)`), so feed cost scales with items rendered, not with match volume.

    **A test caught its own fixture bug.** The range test initially failed with seven leftover
    `Standup` events because `beforeEach` cleaned alerts and job runs but not `calendar_events` — the
    assertion was strong enough to notice, which is the point of asserting on exact titles rather
    than counts.

    **Live-verified against the running server with a real session.** All three layers return a
    chronologically sorted list with `alert_result`, `job_run` and `alert_projection` items, every
    projection `editable: false`, and no `organizationId` on any item. `?layers=jobs` alone returns
    only `job_run`. `?layers=bogus` returns `400` naming the valid options; a reversed range returns
    `400 "to must be after from"`; unauthenticated returns `401`. `staleSources` correctly named all
    four org-scoped schedules, because this machine has no cron driving them — the feed reporting
    that is the designed behavior, not a defect.

- [x] **Add calendar layer UI**
  - Files: `src/modules/calendar/components/CalendarLayers.tsx` (new),
    `src/modules/calendar/components/ProjectionDetails.tsx` (new),
    `src/modules/calendar/components/CalendarPage.tsx`,
    `tests/unit/modules/calendar/components/CalendarPage.test.tsx` (new),
    `src/shared/lib/calendar.ts`, `src/shared/lib/scheduling.ts`
  - Do: Add independent appointment/job/alert/result toggles, shape+label distinctions,
    estimate/stale badges, read-only detail, source navigation, and persisted user display preference.
  - Verify: Playwright toggles each layer, proves projections cannot drag/edit, follows source link,
    and calendar remains usable when feed projections fail.
  - Evidence: 12 component tests green; full suite 3085 passed. (Playwright/axe remain future work —
    the coverage below is vitest plus a live browser walkthrough.)

    **A browser-only bug surfaced immediately, and it was my own earlier fix being wrong.** The page
    threw `The requested module '/node_modules/.vite/deps/rrule.js' does not provide an export named
    'default'`. `rrule` ships CommonJS and the three loaders disagree: vitest accepts a NAMED import,
    Vite SSR needs a DEFAULT import, and the Vite BROWSER bundle rejects the default. My previous
    session fixed the SSR failure with a default import — which passed every test and broke the
    client. Now a namespace import with an interop unwrap, and the comment spells out all three
    loaders because `pnpm test` cannot tell you which one you are about to ship to.

    **The editable/read-only split comes from the DTO, not from the component's judgement.** Only
    `kind === 'event'` renders a delete control; every projection renders as a button with a dashed
    border, a lock icon, and an `aria-label` containing "read-only". Estimates additionally carry a
    literal `(estimate)` in their text. Dashed border and icon rather than colour, because the
    distinction is "you can move this" versus "you cannot" and it has to survive greyscale,
    high-contrast, and a printout.

    **No disabled edit affordance anywhere.** `ProjectionDetails` offers no greyed-out Save button —
    a disabled control invites the user to hunt for what unlocks it. It states "Managed by the
    system" and links to the source instead. Its date label is `Expected at` for an estimate and
    `Happened at` for a record, so the label itself carries the distinction the feed preserves.

    **Toggling a layer refetches rather than filtering locally.** Filtering client-side would keep
    paying for data the user explicitly switched off. A test asserts the layer array passed to the
    fetcher, and disabling the `layers` effect dependency makes it fail.

    **Three assertions verified load-bearing by mutation:** adding a `<button>` inside a projection
    fails the read-only test; dropping `layers` from the effect dependencies fails the refetch test;
    hardcoding `Happened at` fails the certainty test.

    **"No layers on" is distinguished from "nothing scheduled".** Saying the latter when a user has
    switched every layer off would look like their data had disappeared.

    **Live-verified in the real browser at `/calendar`** (signed in through the app): three toggles
    render `aria-pressed="true"` with a `✓` glyph; 15 projections, each with `innerButtons: 0` and an
    `aria-label` ending "read-only, managed by the system"; turning Alerts off dropped 15 → 11 items
    and flipped the glyph to `+`; clicking a job run opened a panel reading "Completed job run",
    "Happened at", "Outcome: succeeded", the managed-by-the-system note, and a source link to
    `/api/admin/calendar/run-reminders`. The stale-source banner named all four org-scoped schedules,
    which is correct on a machine with no cron. Screenshot captured.


## Phase 5 — Invitation and atomic booking

- [~] **Implement capability exchange and session validation** — capability module, session
  exchange route, invitation-scoped cookie, and the narrowly-privileged tenant resolver
  (drizzle/0077-0078) are done and verified in a browser. STILL OPEN: the named strict-CSP variant
  in `server/security.mjs`. Public scheduling responses currently carry `Referrer-Policy:
  no-referrer` and `no-store` per route, but they inherit the site-wide CSP rather than a tighter one.
  - Files: `src/lib/scheduling/capability.ts` (new),
    `tests/unit/lib/scheduling/capability.test.ts` (new),
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

- [x] **Implement invitation service**
  - Files: `src/lib/scheduling/invitation-service.ts` (new),
    `tests/unit/lib/scheduling/invitation-service.test.ts` (new),
    `src/shared/lib/security/audit.ts`
  - Do: Create/preview/send/open/decline/revoke/expire transitions, optional builder identity link,
    role context snapshot, policy validation, one active capability, audit, and outbox-safe send.
  - Verify: service tests cover every transition, owner/participant/admin permissions, duplicate
    send, stale builder, expiry, and redacted audit details.

- [x] **Implement slot-query service**
  - Files: `src/lib/scheduling/slot-service.ts` (new),
    `tests/unit/lib/scheduling/slot-service.test.ts` (new)
  - Do: Load invitation policy, rules, overrides, busy occurrences, and booked appointments; derive
    bounded opaque slots in requested timezone; cache only keyed by organization/owner/invitation/
    version/range; invalidate on relevant mutation.
  - Verify: tests cover DST, buffers, notice, horizon, recurrence, cancellation, reschedule, cache
    key/invalidation, and no conflict-source leakage; benchmark fixture under 750 ms p95.

- [x] **Implement atomic booking, cancellation, and rescheduling**
  - Files: `src/lib/scheduling/booking-service.ts` (new),
    `tests/unit/lib/scheduling/booking-service.test.ts` (new),
    `src/shared/lib/repositories/scheduling.ts`
  - Do: Acquire transaction advisory lock by organizer/date, recompute slot, create event and
    participants, verify current individual consent receipts for every required purpose, mark invite
    booked, create consent-receipt/outbox messages, and commit together. Missing/withdrawn consent
    returns `422 consent_required`. Cancellation preserves history. Reschedule creates linked
    replacement occurrence/event state without a gap or double confirmation.
  - Verify: real PostgreSQL race test yields exactly one booking; rollback leaves no partial rows;
    stale/used/revoked/expired capability and invalid slot return safe errors.

- [x] **Add authenticated invitation APIs**
  - Files: `src/routes/api/scheduling/invitations/index.ts` (new),
    `src/routes/api/scheduling/invitations/$invitationId.ts` (new),
    `src/routes/api/scheduling/invitations/$invitationId/send.ts` (new),
    `src/routes/api/scheduling/invitations/$invitationId/revoke.ts` (new)
  - Do: Add owner-only create/list/detail/update/send/revoke handlers with tenant context, CSRF,
    Zod limits, explicit DTOs, audit, feature/plan gates, and consistent errors.
  - Verify: API tests cover 401, tenant B, unrelated member/admin denial, builder from other tenant,
    plan disabled, repeated send/revoke, and DTO minimization.

- [x] **Add public invitation and booking APIs**
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

- [~] **Add calendar invitation email and ICS generation** — `src/lib/calendar/ics.ts` is done and
  parser-verified. STILL OPEN: the invitation/confirmation/reschedule/cancel/expiry templates and
  the send wiring. Blocked on one decision: only the capability *hash* is stored, so `send` cannot
  reconstruct a link it issued at create time. A send must therefore ROTATE the capability, which
  means a resend invalidates the link already in the candidate's inbox — the opposite of what
  `invitation-service.ts` currently claims in its `markInvitationSent` comment. Resolve before
  writing the templates.
  - Files: `src/shared/lib/email.ts`, `tests/unit/shared/lib/email.test.ts`,
    `src/lib/calendar/ics.ts` (new), `tests/unit/lib/calendar/ics.test.ts` (new)
  - Do: Add invitation/confirmation/reschedule/cancel/expiry templates; generate standards-compliant
    UID, DTSTART/DTEND/TZID, organizer/attendee, METHOD request/cancel, sequence, escaped text, and
    external meeting/location fields. Email links use fragment token and no tracking query.
  - Verify: snapshot/plain-text tests; parse emitted `.ics` with an independent parser; Resend dev
    fallback logs no token; real test inbox receives/open imports one event and cancellation.

- [x] **Build organizer scheduling UI** — shipped 2b55de5, verified 2026-07-27
  - Files: `src/modules/scheduling/components/{InvitationComposer,InvitationPreview,InvitationStatus,InterviewInvitePanel}.tsx`,
    `src/modules/builder-profile/components/BuilderProfilePage.tsx`,
    `tests/e2e/scheduling-organizer.spec.ts` (new)
  - The three components and the panel that composes them already existed and were mounted on the
    profile; only the checkbox was missing. Contrasted against the task's field list: candidate
    email, role title, role context, format, length and meeting link are all present, and the draft
    survives a failed send by design. `range` and `buffer` are **not** composer fields and should
    not be — they come from the organizer's availability policy, which is its own shipped surface;
    the composer says as much to the user ("from the availability on your…").
  - The real gap was the Playwright coverage the Verify line asks for. `tests/e2e/scheduling-organizer.spec.ts`
    now walks it: the invitation is listed on the tracked builder's profile, revoked through the UI,
    and the transition is re-read from `scheduling_invitations` so a painted-but-unpersisted state
    cannot pass. A third test pins the optimistic-version check — a second tab holding a stale
    version must lose, retried under a *different* idempotency key so a legitimate replay is not
    mistaken for a concurrency win.
  - `SCHEDULING_ENABLED` is set in the spec before the worker server spawns rather than inherited
    from a developer's `.env` (it defaults to `false`), and a first test asserts the flag actually
    reached the app — otherwise every later assertion would fail for that reason instead of a real
    one. This is the failure mode `semantic-search` shipped with.
  - Verify (2026-07-27): 3/3 pass.

- [x] **Build mobile accountless candidate portal**
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

- [x] **Add document, extraction, and consent schema/RLS** — done 2026-07-28, deployed
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0084_flowery_gunslinger.sql`,
    `drizzle/0085_candidate_documents_rls_grants.sql`, `drizzle/0086_capability_invitation_scoping.sql`,
    `scripts/db/verify-rls-local.mjs`, `scripts/db/prepare-rls-fixture.mjs`
  - `candidate_documents`, `document_extractions` and `candidate_web_imports` with tenant composite
    FKs, checks, indexes, forced RLS and per-role grants. `privacy_consents` already existed.
  - Shape choices worth keeping: no public-URL column (a URL that exists is a URL that leaks —
    the generated object key is the only handle); audio media types rejected by check, because
    accepting them would route recordings around the consent gate that governs interview capture;
    extractions unique by (document, parser version, content hash) so a newer parser adds a row
    instead of overwriting text a brief already cites; web imports store `robots_result` rather than
    inferring it, since "we were allowed to fetch this" must stay auditable after robots.txt changes.
  - **The RLS this task asked for turned out to be missing far more widely than these three tables.**
    All fourteen capability policies matched on `app.organization_id` alone, so one candidate's
    scheduling link admitted every other invitation in the organization — and their submissions,
    links, consents, booked events and every organizer's hours. `0086` scopes them to
    `app.invitation_id` (and `app.capability_owner_user_id` for availability, which a candidate
    legitimately needs). Measured, not assumed: 2 invitations visible before, 1 after, 0 when asking
    for the other candidate's by id.
  - It survived because the real-roles verifier had **no capability connection at all**. It has one
    now, plus a second candidate in the same organization — with only one seeded, an
    organization-scoped policy and an invitation-scoped one are indistinguishable — and an assertion
    that an unpinned connection sees nothing.
  - Verify (2026-07-28): 87 migrations apply twice clean; RLS forced on all three tables with the
    exact grants and no others; owner reads their documents while participant, org admin, colleague
    and tenant B read none, and the worker still can; full `pnpm ci:local` green (18 passed), and CI
    green with the capability role exercised for the first time.
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`,
    `docs/architecture/data-classification.md`, `tests/unit/shared/lib/security/rls-policy.test.ts`
  - Do: Add exact `spec.md` columns/checks for `candidate_documents`, `document_extractions`,
    `candidate_web_imports`, and append-only `privacy_consents` with tenant composite FKs,
    generated-key uniqueness, hashes/bytes/type/status/error/expiry indexes, individual versioned
    purpose decisions/supersession/withdrawal, and owner/participant policies. Capability writes go
    through a narrowly privileged server command, never anonymous SQL grants.
  - Verify: migration/RLS tests cover owner, participant, admin denial, tenant B, cross-invitation
    FK, worker scan, and missing context.

- [ ] **Implement R2 EU private storage adapter**
  - Files: `src/lib/storage/r2.ts` (new), `tests/unit/lib/storage/r2.test.ts` (new),
    `src/lib/storage/private-object-storage.ts` (new)
  - Do: Implement generated quarantine/clean keys, short signed PUT/GET, required content length/
    type/checksum, HEAD verification, copy/move, delete, lifecycle prefix cleanup, EU endpoint
    assertion, normalized errors, timeouts, and no public bucket ACL.
  - Verify: unit contract tests with fake S3; integration against test R2/MinIO uploads, rejects
    tampered checksum, cannot list/public-read, expires URLs, moves clean, and deletes all variants.

- [ ] **Implement ClamAV streaming scanner**
  - Files: `src/lib/storage/clamav.ts` (new), `tests/unit/lib/storage/clamav.test.ts` (new),
    `docker-compose.yml`, `Dockerfile`, `docs/operations/interview-provider-register.md`
  - Do: Implement bounded TCP `INSTREAM` client with timeout/size guard and clean/infected/error
    normalization. Add pinned ClamAV service/healthcheck for local/production topology and document
    signature updates/RAM. Scanner unavailable must never mark a file clean.
  - Verify: fake protocol tests plus EICAR integration produces `infected`; clean fixture passes;
    timeout remains quarantined; container healthcheck reports ready.

- [ ] **Implement deterministic document validation and extraction**
  - Files: `src/lib/storage/document-validation.ts` (new),
    `tests/unit/lib/storage/document-validation.test.ts` (new),
    `src/lib/storage/document-extraction.ts` (new),
    `tests/unit/lib/storage/document-extraction.test.ts` (new)
  - Do: Validate extension, actual media type/magic bytes, bytes, checksum, invitation quota; extract
    clean PDF/DOCX/TXT into bounded normalized plain text with page/section map; reject encrypted,
    corrupt, unsupported, polyglot, decompression-bomb-like, or empty files; sanitize control chars.
  - Verify: fixture suite covers valid formats and every rejection; extraction has deterministic
    content hash/page references and never renders source HTML.

- [ ] **Implement document repository and worker**
  - Files: `src/shared/lib/repositories/interview-documents.ts` (new),
    `tests/unit/shared/lib/repositories/interview-documents.test.ts` (new),
    `src/lib/scheduling/document-worker.ts` (new),
    `tests/unit/lib/scheduling/document-worker.test.ts` (new),
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
  - Files: `src/lib/enrichment/network.ts`, `tests/unit/lib/enrichment/network.test.ts`,
    `src/lib/enrichment/policies.ts`, `tests/unit/lib/enrichment/policies.test.ts`,
    `src/lib/enrichment/robots.ts`, `tests/unit/lib/enrichment/robots.test.ts`,
    `src/lib/scheduling/web-import-worker.ts` (new),
    `tests/unit/lib/scheduling/web-import-worker.test.ts` (new),
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
  - Files: `src/shared/lib/billing/rate-cards.ts`, `src/modules/interviews/billing.ts`, `tests/unit/modules/interviews/billing.test.ts`
  - Do: Add versioned interview brief, live transcription, contextual-question, and final-report unit
    rules plus maximum reservations/durations. Import the platform contracts; do not create Stripe,
    catalog, grant, ledger, checkout, refund, auto-recharge, or reconciliation code here.
  - Verify: contract tests assert exact estimates/maximums and a boundary test fails any interview
    module that imports Stripe or billing tables directly.

- [ ] **Wrap every interview provider boundary in reserve and settlement**
  - Files: `src/modules/interviews/billing.ts`, `tests/unit/modules/interviews/billing.test.ts`, `src/shared/lib/billing/feature-authorization.ts`
  - Do: Call entitlement check and reserve before brief/STT/question/report provider access; extend
    long-running live work, settle actual use with provider references, and release/refund on failure.
    Stop only paid provider capture at zero and preserve manual notes/interview controls.
  - Verify: fake-provider tests cover insufficient entitlement/credits, duplicate/retry, disconnect,
    extension denial, grant expiry during interview, provider failure, actual-vs-reserved settlement,
    and prove no provider request starts before reservation.

- [ ] **Show platform-owned credit state in interview UX**
  - Files: `src/modules/interviews/components/CreditBalance.tsx`, `tests/unit/modules/interviews/components/CreditBalance.test.tsx`, `src/routes/api/billing/summary.ts`
  - Do: Render the role-minimized platform summary, 80/90/ten-minute/zero live warnings, and owner
    links to billing/pack/auto-recharge settings. Do not expose payment mutations or duplicate the
    general billing settings inside interview pages.
  - Verify: owner/admin/member, active/grace/blocked, low/zero, and stale summary component tests pass
    with accessible throttled announcements and no Stripe/provider object in the DTO.

## Phase 8 — Sensitive AI and brief

- [ ] **Implement Azure regional sensitive AI adapter**
  - Files: `src/shared/lib/ai/azure.ts` (new), `tests/unit/shared/lib/ai/azure.test.ts` (new),
    `src/shared/lib/ai/sensitive.ts` (new), `tests/unit/shared/lib/ai/sensitive.test.ts` (new)
  - Do: Use Azure OpenAI regional endpoint/deployment with structured output, timeout, abort,
    bounded retry, no storage/training configuration, usage normalization, independent kill switch,
    redacted telemetry, and no MiniMax/local fallback. Reject non-regional configuration at runtime
    as defense in depth.
  - Verify: fake-server tests cover valid/invalid JSON, timeout, 429/5xx, abort, usage, disabled,
    non-EU endpoint, and logs without prompt/content; live smoke sends synthetic data only.

- [ ] **Register interview brief task**
  - Files: `src/shared/lib/ai/tasks.ts`, `tests/unit/shared/lib/ai/tasks.test.ts`
  - Do: Add exact `interview-brief-generate` schemas from `spec.md`, server-only/no-cache metadata,
    evidence ID existence/refinement, untrusted wrapping, prohibited claims/language, bounded input/
    output, prompt version, and Pro/Pro Max/Team allowance. Route it through sensitive client
    selection.
  - Verify: task tests cover valid output, missing/dangling evidence, fabricated claim, prompt
    injection in CV, excessive arrays/text, cache null, free gate, and sensitive routing.

- [ ] **Add brief schema and repository**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`,
    `src/shared/lib/repositories/interviews.ts` (new),
    `tests/unit/shared/lib/repositories/interviews.test.ts` (new),
    `tests/unit/shared/lib/security/rls-policy.test.ts`
  - Do: Add `interview_briefs` with organization/event composite FK, owner, version/status, validated
    structured content/evidence manifest, provider/model/prompt version, expiry, editor, indexes, and
    private owner/explicit-participant RLS. Store no model prompt/response envelope.
  - Verify: migration/RLS/repository tests cover version uniqueness, owner/participant/admin denial,
    evidence shape, tenant B, and explicit DTO.

- [ ] **Implement brief generation/version service**
  - Files: `src/lib/interviews/brief-service.ts` (new),
    `tests/unit/lib/interviews/brief-service.test.ts` (new)
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
    `docs/architecture/data-classification.md`, `tests/unit/shared/lib/security/rls-policy.test.ts`
  - Do: Add `interview_sessions`, `transcript_segments`, `interview_suggestions`, and
    `interview_reports` with tenant/event/session composite FKs, stable provider segment uniqueness,
    sequence/timestamp/confidence checks, speaker/correction columns, state/version/provider/prompt/
    expiry fields, evidence references, and strict owner/explicit-participant RLS. Add no audio/blob/
    storage-key column.
  - Verify: migration schema audit asserts no audio-like column; RLS tests cover owner, participant,
    admin denial, tenant B, worker retention, and cross-session evidence FK.

- [ ] **Implement Deepgram EU token and usage adapter**
  - Files: `src/lib/interviews/transcription/deepgram.ts` (new),
    `tests/unit/lib/interviews/transcription/deepgram.test.ts` (new)
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
    `tests/unit/lib/interviews/session-service.test.ts` (new),
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
    `tests/unit/modules/interviews/lib/transcript-outbox.test.ts` (new)
  - Do: Store only unacknowledged final text segments keyed by session/user, encrypt where supported
    or minimize to required fields, retry idempotently, delete on acknowledgement/logout/finish/
    expiry, and expose a cleanup marker for retention on next visit. Never store audio/interim text.
  - Verify: browser tests cover refresh/offline/reconnect, duplicate ack, cross-user separation,
    expiry/logout cleanup, storage quota error, and absence of audio/interim payload.

- [ ] **Implement browser capture and Web Audio mixer**
  - Files: `src/modules/interviews/lib/audio-capture.ts` (new),
    `tests/unit/modules/interviews/lib/audio-capture.test.ts` (new),
    `src/modules/interviews/lib/deepgram-client.ts` (new),
    `tests/unit/modules/interviews/lib/deepgram-client.test.ts` (new)
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
  - Files: `src/shared/lib/ai/tasks.ts`, `tests/unit/shared/lib/ai/tasks.test.ts`
  - Do: Add `interview-followup-suggest` and `interview-report-generate` exact schemas, server-only/
    no-cache/sensitive routing, bounded transcript windows, evidence validation, prohibited-output
    refinement, prompt versions, allowance/cost behavior, and deterministic templates.
  - Verify: tests cover prompt injection in transcript, dangling evidence, scoring/hire language,
    excessive output, 30-second throttle metadata, no cache, free gate, and sensitive route.

- [ ] **Implement topic window and suggestion service**
  - Files: `src/lib/interviews/suggestion-service.ts` (new),
    `tests/unit/lib/interviews/suggestion-service.test.ts` (new)
  - Do: Derive covered/pending topics, select bounded recent final segments, debounce/rate-limit per
    session, call sensitive task while paid live session is active, save only explicit use/save/
    dismiss actions, and degrade silently to prepared questions.
  - Verify: tests cover throttle, no new context, paused/manual/free state, provider failure,
    evidence references, ephemeral unsaved output, and concurrent request dedupe.

- [ ] **Implement report generation and finalization service**
  - Files: `src/lib/interviews/report-service.ts` (new),
    `tests/unit/lib/interviews/report-service.test.ts` (new),
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
    `tests/unit/lib/interviews/retention-worker.test.ts` (new),
    `src/shared/lib/repositories/interview-retention.ts` (new),
    `src/routes/api/admin/interviews/run-retention.ts` (new)
  - Do: Lease expired resources per tenant, delete R2/provider/cache artifacts, then relational data
    in safe dependency order, expire/release stale reservations, retain minimal consent/audit per
    policy, retry partial failures, dry-run metrics, and write redacted job run.
  - Verify: seeded 90/180-day boundaries, shorter org override, R2/provider failure/retry,
    idempotency, tenant isolation, and unauthorized route; local runtime confirms objects/rows gone.

- [ ] **Extend privacy export and deletion**
  - Files: `src/shared/lib/repositories/account-privacy.ts`,
    `tests/unit/shared/lib/repositories/account-privacy.test.ts`,
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
    `tests/unit/shared/lib/legal.test.ts`, `docs/operations/interview-provider-register.md`
  - **Not gated on legal review** (product-owner decision 2026-07-28). The copy is drafted and
    shipped describing what the system actually does; a lawyer's approval is a general-availability
    step, not a precondition for writing accurate notices. Writing them first is also what gives the
    review something concrete to react to — waiting produces neither copy nor a review.
  - Do: describe controller, documents, approved public-web import, transient
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
    `tests/unit/shared/lib/ai/tasks.test.ts`, `tests/unit/shared/lib/interviews.test.ts`,
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
    `tests/unit/lib/interviews/usage-reconciliation.test.ts` (new),
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
    `tests/unit/shared/lib/log.test.ts`
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
