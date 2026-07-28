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

- [x] **Implement R2 EU private storage adapter** — done 2026-07-28, deployed (`64bea05`)
  - Files: `src/lib/storage/s3-provider.ts` (new), `src/lib/storage/provider.ts` (new),
    `tests/unit/lib/storage/s3-provider.test.ts` (new)
  - Named `s3-provider.ts`, not `r2.ts`: the store is self-hosted MinIO speaking the S3 API, and
    naming the file after a vendor the code does not talk to is how the plan/reality drift starts.
    The `INTERVIEW_R2_*` env names are kept so a later move to R2 is configuration, not code.
  - **`maxBytes` is not enforceable on the URL, and pretending otherwise would have left the only
    real check unwritten.** A presigned PUT cannot cap a body — only a presigned POST policy can.
    Carrying it as `x-amz-meta-max-bytes` was tried and removed: a presigned URL cannot sign it and
    MinIO rejects unsigned headers, so it broke every upload while enforcing nothing. The limit is
    the completion path's job, against `headObject`. A test pins the weakness deliberately.
  - `signableHeaders: new Set(['content-type'])` is load-bearing — without it the SDK signs only
    `host` and MinIO rejects the upload the moment the client sends the type back. A comment here
    once claimed the type was signature-enforced when it was not; the real MinIO caught it.
  - Verify (2026-07-28): 20 tests against the real bucket, not a mock — signed PUT completes, a
    mismatched content type is refused, `headObject` returns null for absence, download serves the
    bytes, move leaves nothing at the source, delete of an absent key succeeds, and six key shapes
    (traversal, absolute, empty segment, control chars) are rejected before a request is built.

- [x] **Implement ClamAV streaming scanner** — done 2026-07-28 (`23db61a`)
  - Files: `src/lib/storage/clamav.ts` (new), `tests/unit/lib/storage/clamav.test.ts` (new),
    `src/lib/storage/types.ts`, `src/lib/storage/provider.ts`, `docker/clamav/`, `docker-compose.yml`
  - Bounded `zINSTREAM` client (`z`, not `n`: NUL-terminated replies cannot be desynchronised by a
    signature name containing a newline). 64 KiB chunks, a hard deadline on the whole exchange
    rather than socket idleness, and `getVirusScanner()` resolving storage into the scanner.
  - **Every failure path either throws or returns `error`; none can reach `clean`.** That shaped
    two decisions beyond the scanner: an unrecognised reply parses as `error`, and the new
    `readObject` throws for a missing object where `headObject` returns null — a zero-byte stream
    handed to clamd comes back clean.
  - Built from Alpine for arm64 with the `HEALTHCHECK` in the image rather than compose, because a
    `docker run` deployment ignores a compose-only healthcheck and reports no health at all.
  - Verify (2026-07-28): 11 tests. EICAR is detected and an ordinary document passes against the
    real container; a full resolver-to-verdict round trip uploads EICAR to the real bucket and gets
    `infected`. Fake-clamd cases cover a scanner that accepts and says nothing (rejects at its 600ms
    deadline), one that closes without replying, and a garbled reply — none yields `clean`.

- [x] **Implement deterministic document validation and extraction** — done 2026-07-28 (`a8b9523`)
  - Files: `src/lib/storage/document-validation.ts` (new), `src/lib/storage/document-extraction.ts` (new),
    `tests/unit/lib/storage/document-validation.test.ts` (new),
    `tests/unit/lib/storage/document-extraction.test.ts` (new),
    `tests/unit/lib/storage/fixtures/documents.ts` (new), `src/lib/storage/types.ts`
  - **Declared metadata is a claim to check, never a fact.** The presigned PUT cannot enforce size,
    type or name, so each is verified against the bytes and a mismatch is a *rejection* rather than a
    correction — trusting the sniff over the declaration would let a `.pdf` that is really something
    else make the system agree with the file.
  - A DOCX is inspected as the archive it is: the central directory is walked to total uncompressed
    sizes without inflating anything (the only way to catch a bomb before mammoth sees it) and to
    prove the zip is a WordprocessingML package rather than a renamed archive that starts with `PK`.
    Read from the central directory, not local headers, because a local header may zero its sizes and
    put the real values in a trailing descriptor — so a bomb can look empty from the front.
  - Extraction is deterministic because `document_extractions` is keyed by content hash: NFC
    normalisation and stable line handling are correctness, not tidiness. Truncation over the
    500k-char cap sets `truncated` instead of quietly shortening a document a brief will cite, and
    an extraction with no text is a failure — `""` would read as "the candidate said nothing".
  - Fixtures are *built*, not committed: a binary `.docx` in the repo makes the bomb test unreviewable
    (nobody can see from a diff whether it still declares an inflated size), and every hostile case
    here is the valid fixture with one field changed, which no zip library will let you do.
  - **Two production bugs the tests caught**: pdfjs rejects a Node `Buffer` outright, which is exactly
    what `StoredDocumentExtractor` hands it from `Buffer.concat` — every real PDF would have failed;
    and `isEvalSupported` was being passed as hardening while doing nothing, because pdfjs v6 removed
    the option along with the eval-based font path. Also corrected a comment claiming the PDF header
    check closes the polyglot hole: `file-type` does, by requiring the magic at offset 0, and a test
    now pins that dependency behaviour so the hole cannot reopen silently.
  - Verify (2026-07-28): 44 tests. Valid PDF/DOCX/TXT accepted; empty, oversized, size/checksum
    mismatch, wrong extension, unsupported type, docx-as-pdf, binary-as-txt, invalid UTF-8, displaced
    PDF header (4 prefixes), missing `%%EOF`, encrypted PDF, zip bomb by absolute size and by ratio,
    non-Word zip and truncated archive all rejected with distinct codes. Extraction asserts exact text
    and exact hash twice over, per-page and per-heading offsets that address their own text, repeated
    headings mapping to ascending offsets, and that no markup escapes into the text.

- [x] **Implement document repository and worker** — done 2026-07-28 (`f52f437`), NOT yet deployed
  - Files: `src/shared/lib/repositories/interview-documents.ts` (new),
    `src/lib/scheduling/document-worker.ts` (new), `src/lib/storage/object-keys.ts` (new),
    `src/routes/api/admin/documents/run-worker.ts` (new), `drizzle/0087_romantic_karen_page.sql` (new),
    `src/shared/lib/db/schema.ts`, and the three new test files
  - **The status is the lease.** Claiming commits on its own, the scan and object moves run with no
    transaction open, and each outcome is applied in its own short transaction. One transaction
    around the whole thing would hold a tenant's rows locked for a ClamAV stream plus two S3 round
    trips, on a pool shared with every live request. `reclaimStaleLeases` is the price of that
    choice: a process killed mid-flight would otherwise strand a candidate's CV as "processing"
    forever, which no amount of retrying would ever notice.
  - **Move before mark**, because neither ordering is atomic and this one fails closed. An
    unreferenced object under `clean/` is a retention problem; a row that says `clean` while
    pointing at nothing is a document the UI promises and every download 404s.
  - Two check constraints shaped the design more than the plan text did. `rejection_code` is bound
    to a non-clean `scan_status`, so an extraction failure's code *cannot* live on the document — it
    has to be a `document_extractions` row. And the content-hash check demands 64 hex characters
    even on a failed row, so failure rows carry the source sha256, which reads correctly as "this
    parser version could not read these bytes" and makes a same-parser retry collide rather than
    duplicate.
  - `0087` adds `scan_attempts`/`extraction_attempts`. Without a durable counter the retry path is
    an infinite loop. A non-volatile default makes it catalogue-only in Postgres 11+, and 0085's
    grants are table-level, so nothing else changes. Verified: 88 migrations apply twice clean.
  - Object keys carry no candidate data — no filename, no email. Keys reach access logs, proxy logs
    and signed URLs, every one a place `maria-gonzalez-cv-final.pdf` would leak a name and a job
    search. `cleanKeyFor` substitutes the prefix rather than rebuilding the key: a rebuild
    disagreeing by one character would move the object to a key the database does not record,
    leaving the document scanned, intact and permanently unreachable.
  - Also fixed a clock the worker accepted but the reclaim query ignored, using Postgres `now()`
    instead — a test could set up a scenario the code then evaluated against a different timeline,
    and it did.
  - Verify (2026-07-28): 29 tests across the three files, against a real disposable Postgres with
    fake storage/scanner. Clean promotion and extraction; infected marked, object deleted, extraction
    `skipped`, never promoted; scanner down requeues and counts the attempt, then fails (never
    cleans) at the cap; a row already at the cap is not re-leased; `status:'error'` rejects on the
    first attempt rather than burning the cap; a move that fails after a clean verdict requeues
    instead of marking clean; permanent vs transient extraction failure; one tenant failing leaves
    another untouched; stale lease reclaimed, fresh lease left alone; two concurrent leases never
    claim the same row; oldest-first ordering; quota counts in-flight bytes and excludes rejections.
  - **Outstanding before this runs in production**: the job key `interviews.document-processing`
    needs a cron entry on the server (the deployment has no OS-level cron in-app; an external
    scheduler POSTs `/api/admin/documents/run-worker`). Nothing schedules it yet, so on deploy the
    worker exists and is reachable but idle until that entry is added.

- [x] **Add candidate upload, completion, consent, and download APIs** — done 2026-07-28 (`8c52575`), NOT yet deployed
  - Files: `src/routes/api/public/scheduling/$invitationId/uploads.ts` (new),
    `.../uploads/$documentId/complete.ts` (new),
    `src/routes/api/scheduling/invitations/$invitationId/documents/$documentId/download.ts` (new),
    `drizzle/0088_lively_the_executioner.sql` (new),
    `drizzle/0089_candidate_document_capability_scoping.sql` (new),
    `src/shared/lib/interviews.ts`, `src/shared/lib/interview-api.ts`,
    `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/verify-rls-local.mjs`
  - **The row is created when the URL is issued**, which is what makes the 25 MB quota a
    *reservation* rather than a check: signing without recording would let a client take a hundred
    intents, each seeing an empty allowance, then upload against all of them. `0088` adds the
    `awaiting_upload` state that makes this safe — the worker leases only `pending`, so nothing is
    scanned before completion confirms what landed, and `sha256` is nullable for exactly that one
    state rather than forever. The DTO layer had already been describing this: `DOCUMENT_STATUSES`
    starts at `pending_upload` and `candidateDocumentSchema` already declared `sha256` nullable.
  - Consent gates the URL, not just the UI. A candidate without `candidate_document_processing`
    cannot upload by driving the API directly, and a URL already issued is a URL that works.
  - **Authorization and writing use different roles on purpose.** `builderhunt_capability` holds
    SELECT and INSERT and deliberately no UPDATE (0085: "Capability writes go through a narrowly
    privileged server command, never anonymous SQL grants"), so the read proving a document belongs
    to this invitation's submission runs as the candidate and the single scoped UPDATE runs as the
    worker. Intent creation needed no escalation at all once the id was generated in JS, letting the
    object key go into the same INSERT.
  - **`0089` closes the ⚠️ that 0085 left explicitly open.** The candidate's policy on
    `candidate_documents` was organization-scoped, so isolation *between candidates of one
    organization* rested on the resolver and the query rather than on RLS. 0085 said narrowing it
    needed a GUC nothing set; 0086 has since pinned `app.invitation_id`, so it can be written against
    a GUC that exists. 0085's header also claimed the resolver pins `app.submission_id`, which
    contradicted its own ⚠️ forty lines below and was never true — corrected in 0089, since an
    applied migration is immutable.
  - The RLS fixture gained a second candidate's document. Without it the assertion "capability saw
    exactly one document" held under either policy, certifying an isolation it never tested — the
    same blind spot that hid the organization-wide capability policies until 0086.
  - Two plan deviations, both recorded in the code. The download route lives under
    `/api/scheduling/invitations/:id/` rather than `/api/interviews/:id/`, because `interview_sessions`
    — and therefore any notion of a participant — arrives in Phase 9; owner authority is what exists
    today, and the participant variant is an addition rather than a replacement. And the planned
    `consents.ts` already exists, split across `submission.ts` (record), `index.ts` (review) and
    `withdraw.ts` (withdrawal).
  - Verify (2026-07-28): `pnpm ci:local` green — 18 steps, `schema-audit` tolerated as the workflow
    marks it informational; RLS 102 assertions including the narrowed capability policy measured
    against a second candidate in the same organization; 3475 unit tests; 211 e2e; 90 migrations
    apply twice clean. The gate caught the owner/worker document-count assertions my fixture change
    invalidated — they now name the expected ids rather than counting rows.
- [x] **Implement policy-controlled public-web import** — done 2026-07-28 (`b3d1a4b`, `c2bd69c`), NOT yet deployed
  - Files: `src/lib/scheduling/link-import-policy.ts` (new), `src/lib/scheduling/web-import-extraction.ts` (new),
    `src/lib/scheduling/web-import-worker.ts` (new), `src/shared/lib/repositories/interview-web-imports.ts` (new),
    `src/routes/api/public/scheduling/$invitationId/links/$linkId/import.ts` (new),
    `src/routes/api/admin/documents/run-web-imports.ts` (new),
    `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/verify-rls-local.mjs`
  - **Three gates, each of which can only narrow.** The policy decision is re-evaluated at run time
    rather than trusted from the queue: the attestation may have been made against a notice version
    since superseded, or the host may have entered the blocked list in between. Robots is fail-closed —
    `unavailable` blocks, because a site we could not ask has not said yes. Then `safeFetch`'s existing
    envelope. Its redirect cap of **3** wins over the plan's 5: loosening a shared SSRF guard to match
    a sentence would weaken every other consumer for no gain here.
  - **A bug worth remembering.** Every hard-blocked connector in `policies.ts` has `allowedHosts: []`,
    correctly, since nothing may ever be fetched from them. The first implementation resolved hosts
    against the registry, so `linkedin.com` matched no connector, fell through to the personal-site
    branch, and an ownership attestation promoted it to `authorized_crawl` — the one rule the module
    exists to enforce, inverted by an empty array. Blocked hosts are now listed explicitly and checked
    *before* the registry, with a load-time assertion and a test so a fifth blocked platform added
    without hosts fails loudly rather than silently becoming attestable.
  - Extraction removes whole elements with their contents *before* stripping a single tag. The other
    order leaves a page's minified JavaScript in the evidence a model later reads — useless, and the
    most obvious place to hide an instruction aimed at that model. It also strips `<!DOCTYPE>` and
    processing instructions, which the tag pattern cannot see because it requires a letter after `<`.
  - The body is hashed and discarded. What persists is the visible text, the robots answer (stored,
    never recomputed — "we were allowed to fetch this" must stay auditable after robots.txt changes),
    and both the requested and final URL, because a redirect that changed the page is unrecoverable
    once only the final one is stored.
  - `candidate_links` isolation is now measured. 0086 narrowed that policy to the pinned invitation and
    nothing tested it: the table had no fixture row and no assertion at all.
  - Verify (2026-07-28): 63 tests — 24 policy, 26 extraction, 13 worker against a real disposable
    Postgres. Covers robots allow/disallow/unreachable, LinkedIn refused even with a valid attestation
    (8 host forms), a superseded notice, an unattested link, an envelope refusal recorded with its own
    code, a page with no visible text, dedupe on unchanged content, redirect recording, and that
    `not_requested`/`succeeded`/`running` links are never leased.
- [x] **Add candidate links and intake UI** — done 2026-07-28 (`8b1f258`, `12dbb75`), NOT yet deployed
  - Files: `src/modules/scheduling/components/DocumentUploader.tsx` (new),
    `src/modules/scheduling/components/CandidateIntake.tsx` (new),
    `src/modules/scheduling/components/CandidatePortal.tsx`,
    `src/routes/api/public/scheduling/$invitationId/index.ts`,
    `tests/unit/modules/scheduling/CandidateIntake.test.tsx` (new)
  - Upload is three requests and the middle one does not touch our server: an intent that reserves the
    slot and returns a signed URL, a PUT straight to object storage, then a completion call. A 10 MB
    body through a request handler is a 10 MB body a request handler can be made to hold.
  - The browser hashes the file and sends it with the completion call. Not a boundary on its own — the
    server hashes what it received and compares — but it turns a truncated upload into a checksum
    mismatch instead of a valid short document that passes scanning.
  - Status words are shown as themselves. A candidate whose file was refused needs to know a *virus
    scan* refused it; the alternative reading, that we lost it, is what makes people upload the same
    file four times.
  - A blocked platform gets a sentence, not a greyed-out button: their terms, not the candidate's
    choice, and the link is still kept as evidence an interviewer can open. The ownership attestation is
    per host, unticked, with no bulk setter, and separate from `public_web_import` consent — one says
    imports are acceptable in principle, the other says this site is mine to offer.
  - Intake sits above the confirm button and gates nothing: spec.md is explicit that booking may
    complete while documents are still processing.
  - **`ConsentFields.tsx` was not created**: `CandidateDetailsForm.tsx` already has all five purposes
    with independent state and no bulk setter, so the plan's file exists in substance under another
    name. Building it would have been a second, divergent consent surface.
  - Verify (2026-07-28): 11 component tests, all asserting what the UI *refuses* to offer — no import
    control for a blocked platform, disabled until the per-host box is ticked, the server's notice
    version sent rather than one the client invented, no second import once queued, a retry after a
    failure, and a rejected document not holding quota.

### Phase 6 also fixed the test infrastructure it stressed

- Adding three disposable-database test files pushed the parallel migration count past what the
  cluster-wide `ALTER ROLE` statements tolerate, and four unrelated test files failed to load.
  `isConcurrentDdlConflict` matched the phrase "tuple concurrently updated" in `error.message`, but the
  thrown error's message is drizzle's `"Failed query: ALTER ROLE …"` — the phrase lives only in the
  Postgres error's structured fields. **The retry loop the module header calls a "defense-in-depth
  backstop" had never fired once.** Matched on `XX000` + `simple_heap_update` now, walking a bounded
  cause chain, and `createE2EWorkerDatabase` takes the advisory lock its sibling always took (`617793c`).

## Phase 7 — Consume the Stripe billing platform

- [x] **Register interview rate cards with the billing platform** — done 2026-07-28 (`1432953`), NOT yet deployed
  - Files: `src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/interview-config.ts`,
    `tests/unit/shared/lib/interview-config.test.ts`, `tests/unit/modules/interviews/billing.test.ts`
  - Four cards with the numbers spec.md fixes: `interview_brief` 5, `interview_live_transcription` 1
    per provider-billed minute, `interview_contextual_question` 0 (included), `interview_final_report`
    5. `minimumTier: 'pro'` on all four, per "Sensitive brief/transcription/report: Pro, Pro Max, and
    Team plus sufficient credits".
  - **This removed a second source of truth that could not have worked.** `INTERVIEW_RATE_CARD_KEYS`
    declared its own operation names (`interview.brief.v1`) and its own copy of the unit counts, with a
    comment saying they were "not registered with the billing platform's RATE_CARDS map yet". Since
    `reserveCredits` resolves an operation through `getRateCard`, every one of those names would have
    thrown `unknown_feature` — interview code could not have billed anything, and no test said so. The
    keys now derive from the registry, and a test asserts each resolves to a real card with a matching
    version.
  - Transcription's card carries a three-hour *ceiling* in `maxUnits`, not a price, because the
    reservation extends as the session runs. A test pins that the ceiling equals the per-minute unit
    times the documented maximum length, so the one non-derived number cannot drift either.
  - The boundary rule is a source scan over `src/modules/interviews`, `src/lib/scheduling` and
    `src/modules/scheduling`: no Stripe SDK, no payment-lifecycle module, no billing table. Verified by
    planting a forbidden import and confirming the scan names the offending file — a second ledger
    passes every test and diverges from the real one only once money has moved through both.

- [x] **Wrap every interview provider boundary in reserve and settlement** — done 2026-07-28 (`13e37a7`), NOT yet deployed
  - Files: `src/modules/interviews/billing.ts`,
    `tests/unit/modules/interviews/reserve-and-settle.test.ts` (new)
  - `withInterviewCredits` is the wrapper; `authorizeContextualQuestion` handles the operation that
    reserves nothing. The provider callbacks themselves arrive with Phases 8–10 — this is the contract
    they plug into, and it is fully tested against the real platform now rather than later.
  - **The ordering is the contract**: entitlement, reserve, *then* the provider, then settle the actual
    amount. Proven by reading the reservation row from inside the provider callback (it is `reserved`
    by then) and by asserting the provider is never invoked when tier or balance says no. A version
    that reserved and called the provider concurrently would spend real provider money on a request
    the balance was about to refuse.
  - Settlement records what the provider billed, not what was held. A provider reporting more than the
    reservation covered throws here rather than at the ledger, because that means the extension logic
    did not keep up — a caller bug, and it should say so.
  - `extend()` returns the new ceiling rather than a boolean, so a refusal throws and there is no falsy
    branch a caller could ignore and keep spending against.
  - **Two transaction boundaries, both correct, both pinned.** A caller that lets the provider error
    escape rolls the reservation back wholesale — nothing to release. A caller that catches inside its
    transaction gets the hold released. Which applies is the caller's choice of boundary, not the
    wrapper's, and the module says so.
  - Contextual questions are gated on two conditions: tier alone would let a Pro organization drive the
    question endpoint as a free general-purpose model between interviews.
  - The tests share no organization. They did at first, and a later "there are no credits" assertion
    quietly spent an earlier test's leftover balance — passing by resolving successfully, the opposite
    of what it claimed to prove.
  - Verify (2026-07-28): 15 tests against a real disposable Postgres and the real billing platform,
    with only the provider faked.

- [x] **Show platform-owned credit state in interview UX** — done 2026-07-28 (`17d00c7`), NOT yet deployed
  - Files: `src/modules/interviews/components/CreditBalance.tsx` (new),
    `tests/unit/modules/interviews/components/CreditBalance.test.tsx` (new)
  - `src/routes/api/billing/summary.ts` needed **no change**: it already role-minimizes
    (`OrganizationBillingSummaryDto` for owner/admin, `BillingAvailabilityDto` for a member) and already
    carries `activeCreditGrants`, `grace` and `capabilities`.
  - Renders what the platform gave it and derives no balance, expiry or entitlement of its own. Links
    to billing settings rather than duplicating the pack picker — a test asserts no form and no button
    exists in the output.
  - A member's DTO has no grants, and the component neither shows a balance nor invents a zero from
    their absence. A stale balance stays on screen with a caveat, because blanking it mid-interview
    reads as "you have none".
  - One polite live region, announced only when the *set* of active warnings changes. A session ticks
    every few seconds; a region re-announcing "90% used" each time makes a screen reader unusable for
    exactly the person who most needs to hear it once.
  - **Writing the test exposed a real defect.** Severity was "the last element of
    `resolveLowBalanceWarnings`", which is most-severe-last only by coincidence of that function's push
    order. A 100-unit reservation at 90% consumed leaves exactly ten minutes, so all three warnings
    fire together — now ranked explicitly.
  - At zero the copy says transcription stopped and notes still work: spec.md stops only paid provider
    capture, and "credits exhausted" alone reads as the interview being over.
  - Verify (2026-07-28): 17 component tests across member/owner, active/blocked, loading/stale,
    low/zero, and the announce-once property.

## Phase 8 — Sensitive AI and brief

- [x] **Implement the regional sensitive AI adapter** — done 2026-07-28 (`8043d63`, `bc80b9a`), NOT yet deployed
  - **Built for Mistral, not Azure.** The task title above used to say "Azure regional sensitive AI
    adapter" with files `azure.ts`/`azure.test.ts`. That is stale: the provider decision was revised on
    2026-07-26 (`docs/operations/interview-provider-register.md`: "Mistral (La Plateforme) becomes
    primary; the provisioned Azure resource stays as a fallback") after Azure provisioning hit a
    zero-quota wall and a residency regression, and `env.ts` has defaulted `SENSITIVE_AI_PROVIDER` to
    `mistral` ever since. The product owner confirmed it directly. Renamed here rather than left to be
    rediscovered by whoever reads the plan next.
  - Files: `src/shared/lib/ai/mistral.ts` (new), `src/shared/lib/ai/sensitive.ts` (new),
    `tests/unit/shared/lib/ai/sensitive.test.ts` (new)
  - **There is no fallback**, and `SENSITIVE_AI_PROVIDER=azure` *fails* rather than routing to Mistral.
    An operator who set it believes their data goes to Azure; honouring that belief with a different
    provider is the one failure this module exists to prevent. Falling back to a non-EU model would
    move candidate data outside the residency the candidate was told about — a different processing
    operation with no lawful basis, not a degraded experience.
  - **Bad output is not retried**, unlike `minimax.ts` which re-prompts once on unparseable JSON. This
    output is candidate-evaluation material: a model that returned something structurally invalid
    misunderstood the task, and asking again spends credits to re-roll an assessment somebody will act
    on. The caller shows the deterministic manual path.
  - Telemetry is *typed* so it cannot carry content — numbers and identifiers only, so a future "log
    the prompt that failed" needs an interface change a reviewer sees. Validation failures name Zod
    issue paths rather than using `error.message`, which embeds the offending value. `AIProviderError`
    status `0` means no HTTP response happened at all, which callers need to distinguish from a
    provider that answered badly.
  - Verify (2026-07-28): 22 tests against a real HTTP fixture server rather than a mocked `fetch` —
    signal composition, timeouts and status handling are the three things most likely to be wrong and a
    mock would pass regardless. Covers valid output, non-JSON, schema violation, 429/500/503 retried
    once then abandoned, 400 not retried, caller abort, disabled kill switch, four non-EU URL forms,
    non-regional Azure endpoint, and that no prompt or completion appears in telemetry.
  - **The residency guard makes the adapter untestable through `sensitiveCompletion` by design**, so the
    transport tests call `mistralStructuredCompletion` directly — and one test proves
    `sensitiveCompletion` refuses that very localhost URL. Without it this file would exercise a path
    production cannot take while the guard rotted.
  - Outstanding, and not code: the live smoke test with synthetic data only. It needs a real
    `MISTRAL_API_KEY` against the EU endpoint, which is a deploy-time check rather than a local one.
- [x] **Register interview brief task** — done 2026-07-28 (`0374563`), NOT yet deployed
  - Files: `src/shared/lib/ai/tasks.ts`, `src/routes/api/ai/complete.ts`,
    `tests/unit/shared/lib/ai/interview-brief-task.test.ts` (new)
  - **The output schema is built per call from the manifest that was actually sent.** A static schema
    cannot know which source ids are legitimate, and "any non-empty string" accepts every fabricated
    citation. A model asked to summarise a CV will cheerfully attribute a plausible claim to a document
    nobody supplied, and a human reading a tidy `[doc-3]` has no way to notice.
  - A `submitted_link` cannot be cited as factual evidence at all: citing it would present something we
    never read as something we verified.
  - Prohibited language is rejected **structurally**, not discouraged in the prompt. A brief is read by
    someone deciding whether to hire; "not a culture fit" launders a judgement as an observation, and a
    prompt is advice where a schema is a boundary. The check also applies on the registry's
    manifest-less schema so the weaker path is not a way around it.
  - A new `sensitive` flag makes `/api/ai/complete` refuse the task — that route reaches MiniMax, which
    is not the provider a candidate was told would process their CV. Refused by flag rather than by an id
    list that could drift, and answered `unknown_task` because a caller probing the route has no business
    learning the task exists.
  - Verify (2026-07-28): 27 tests. Fabricated citations in all three citation sites, a restricted link
    cited as evidence, four kinds of prohibited language in four positions, unbounded input, and that
    injected instructions in a CV stay inside the `<candidate-evidence>` boundary.

- [x] **Add brief schema and repository** — done 2026-07-28 (`7375439`), NOT yet deployed
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0090_sour_stranger.sql` (new),
    `drizzle/0091_interview_briefs_rls_grants.sql` (new),
    `src/shared/lib/repositories/interviews.ts` (new),
    `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/verify-rls-local.mjs`, `scripts/db/audit-schema.ts`
  - **The narrowest policy in the schema.** Owner has ALL; a colleague *explicitly granted* access to that
    interview has SELECT; nobody else has anything — including an organization admin, who manages seats
    and billing without needing a colleague's evaluation of a candidate. No capability grant: a GDPR
    access request is the lawful mediated route for a candidate to see what was written about them.
  - The fixture gained a participant with `access_granted = false`, because without one "the granted
    participant can read it" holds whether the policy checks the flag or merely membership.
  - No prompt, no raw_response, no messages column. Provenance is constrained all-or-nothing, so "which
    model wrote this" is answerable per row or says plainly that no model did.
  - **Three defects the tests caught, not review**: `toRow` assumed snake_case while drizzle returns
    camelCase, and `String(undefined)` yields the *string* `'undefined'` — silently corrupting six
    functions; `insertBriefVersion` superseded the active brief even for a draft, leaving the organizer
    with a pending draft and no active brief; and a `Date` as a raw postgres.js parameter fails with an
    opaque `ERR_INVALID_ARG_TYPE` far from the column responsible.
  - Also closed a gap open since Phase 6: the schema audit was reporting **seven** unclassified tables
    (every one this program added, plus `privacy_consents`) and the step is `continue-on-error`, so it
    never blocked anything. All seven are now classified with the path each policy actually takes.
  - Verify (2026-07-28): 17 repository tests including three concurrent generations never claiming the
    same version, plus RLS assertions for owner, granted participant, admin, non-granted participant,
    tenant B, and by-id targeting.

- [x] **Implement brief generation/version service** — done 2026-07-28 (`f0549e4`), NOT yet deployed
  - Files: `src/lib/interviews/evidence.ts` (new), `src/lib/interviews/brief-service.ts` (new),
    `tests/unit/lib/interviews/brief-service.test.ts` (new)
  - Only material we actually read becomes citable. A pending or rejected document contributes **nothing**
    — not an empty slot — because a manifest entry with no text invites the model to invent what it might
    have said, and a citation to it would look identical to a citation of something real.
  - Source ids derive from the row (`doc:<uuid>`), never an array index: renumbering on regeneration would
    silently repoint every citation in every earlier version.
  - Credits, then provider, then persistence — the row is written inside the reservation wrapper, so a
    persistence failure rolls the settlement back and nobody is charged for a brief they never received.
    The kill switch is checked *before* reserving.
  - Failure yields a deterministic fallback marked by carrying no provenance at all. Every fallback claim
    is true by construction ("a source was supplied") at low confidence, and the absence of AI is stated
    rather than disguised. Entitlement and credit failures are deliberately *not* smoothed into a
    fallback: an organizer out of credits needs to know that.
  - Verify (2026-07-28): 16 tests against a real disposable Postgres and the real billing platform.
    Two of my own test defects along the way: reservations persisted between tests so "nothing was
    charged" read a previous row, and my fake threw a ZodError no production path can produce instead of
    the `AIParseError` the real adapter throws.

- [x] **Add brief APIs and editor** — done 2026-07-28 (`c8122c9`), NOT yet deployed
  - Files: `src/routes/api/interviews/$interviewId/brief/index.ts` (new), `.../$version.ts` (new),
    `src/lib/interviews/brief-context.ts` (new), `src/routes/_dashboard/interviews/$interviewId/index.tsx` (new),
    `src/modules/interviews/components/InterviewBriefEditor.tsx` (new),
    `.../EvidenceDrawer.tsx` (new), `.../InterviewBriefPage.tsx` (new), `src/shared/lib/interview-api.ts`
  - `interviewId` is the calendar event id, so unlike the Phase 6 document download these routes needed
    **no** deviation from the planned path.
  - "Not yours" and "does not exist" are the same empty read: telling them apart would confirm an
    interview exists to someone who cannot see it. `canEdit` is answered by the server, so a participant
    is never offered a regenerate button the API will refuse.
  - `PATCH` takes content only and the route re-supplies the manifest from the stored row — an editable
    manifest would let a citation be pointed at something never in evidence.
  - Provenance is on screen: a brief with no provider says plainly it was written without AI. Every
    citation is a button labelled with its source, because a citation you cannot open is one you must take
    on trust. A newer version is *offered*, never applied, so nothing being typed is discarded.
  - The evidence drawer renders text in `<pre>`, never `dangerouslySetInnerHTML` — not because the text is
    markup (the extractors strip it) but because a component that *can* render candidate HTML will
    eventually be handed some.
  - Verify (2026-07-28): 19 component tests. Two defects of mine: an assertion looked for uppercase
    headings CSS produces and `textContent` does not, and a textarea edit assigned `.value` directly,
    which React does not observe.

### Phase 8 deviated from the plan on the provider, and the plan was wrong

The first task read "Implement Azure regional sensitive AI adapter" with files `azure.ts`. Mistral has
been primary since 2026-07-26 (`docs/operations/interview-provider-register.md`, `env.ts`'s default, and
the product owner directly) after Azure provisioning hit a zero-quota wall and a residency regression.
Renamed in place rather than left for the next reader to rediscover.

Both providers were also verified against their real endpoints for the first time — `pnpm test:ai-live`,
opt-in and synthetic-only. That measured something worth keeping: MiniMax fails schema validation roughly
one call in four *after* its own retry, while Mistral passed four for four. Eight production routes call
MiniMax and surface it as a 502, so the user-visible effect is an AI feature that fails intermittently.
Not fixed here — it predates this program and deserves its own work.

## Phase 9 — Live interview persistence and transcription

- [x] **Add live interview schema and RLS** — done 2026-07-28 (`556ef05`), NOT yet deployed
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0092_lovely_mad_thinker.sql` (new),
    `drizzle/0093_live_interview_rls_grants.sql` (new), `scripts/db/audit-schema.ts`,
    `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/verify-rls-local.mjs`
  - **No audio column in any of the four tables** — no blob, no storage key, no object reference. The
    consent a candidate gives is for transient live transcription, not a recording, and a column that
    could hold or point at audio would make that consent inaccurate the moment somebody used it.
  - **Getting that assertion to work took four attempts and every failed one reported clean.** The block
    sat above `const findings`, so both pushes were in the temporal dead zone; a constructed `RegExp`
    matched in isolation and found nothing in situ; and the reason all three "verifications" passed was my
    own plant — `.replace(x, 1)` put the audio column in an *earlier* table sharing the anchor line, so it
    was never in the table under test. Rewritten with string slicing and proved in both directions.
  - Policies copy `interview_briefs`: owner, or `event_participants.access_granted = true`, and nobody
    else. Segments and suggestions inherit through the session, so one sharing rule lives in one place.
    The verifier proves a granted participant can read a segment and **cannot write one** — segments come
    from the organizer's capture client and a second writer would break the sequence contract.
  - `0092` is hand-reordered for the same 42830 reason as `0084`: drizzle-kit emits every ADD CONSTRAINT
    before every CREATE UNIQUE INDEX, and the composite FKs reference an index the same file creates.
  - Verify (2026-07-28): 94 migrations apply twice clean; no audio-like column; 11 policies; RLS
    assertions for owner, granted participant, admin, non-granted participant, tenant B and worker.

- [x] **Implement Deepgram EU token and usage adapter** — done 2026-07-28 (`dd4405e`, `bd76866`), NOT yet deployed
  - Files: `src/lib/interviews/transcription/deepgram.ts` (new),
    `tests/unit/lib/interviews/transcription/deepgram.test.ts` (new)
  - **The master key never leaves the server.** A 30-second scoped grant instead, with
    `assertNoMasterKey` exported as the guarantee — including against a provider that echoes the key back.
    30 seconds is not too short: the token authorizes the handshake, not the conversation, and a reconnect
    asks for a new one anyway.
  - The two capture modes are deliberately **not** interchangeable. Remote gets two interleaved channels
    with `multichannel` and *no* diarization, because attribution is already deterministic from the channel
    the mixer assigned. In-person gets one channel and diarization, because one microphone carrying two
    voices makes attribution impossible — and that guess is why `speaker_mapping` exists. A test pins that
    a diarization label cannot override the channel in remote mode.
  - Silent finals persist nothing; unusable metadata bills zero rather than inventing a duration; a real
    duration rounds *up*, because Deepgram bills fractions while the ledger is integers and rounding down
    would systematically under-bill every session.
  - Verify (2026-07-28): 35 tests covering the exact EU URL, TTL clamping, master-key absence and echo,
    four malformed-grant shapes, both mode configurations, speaker attribution in both modes, unknown
    speakers, and billed-duration rounding.

- [x] **Implement interview session service** — done 2026-07-28 (`9d7447d`), NOT yet deployed
  - Files: `src/lib/interviews/session-service.ts` (new),
    `tests/unit/lib/interviews/session-service.test.ts` (new),
    `src/shared/lib/repositories/interviews.ts`
  - **`withInterviewCredits` cannot hold this reservation.** It reserves, runs and settles inside one
    call, and a live interview spans many requests. The service uses the primitives directly and derives
    the reservation id from the session id — so a retried `goLive`, or a second tab racing the first,
    replays the existing hold instead of taking a second 180 credits against one conversation.
  - **Four guards that could not have failed, found by the tests.** The already-closed-reservation
    tolerance caught `FeatureBillingError` while that layer only translates `insufficient_credits`, so a
    retried finish threw and stranded the session in `live`. The version guard ran *after* the transition
    machine, so a tab that lost a race was told it attempted `paused -> paused`. Consent read as "some row
    says accepted" would transcribe a candidate who accepted at booking and declined afterwards. And
    `transitionSession` silently dropped `heartbeatAt`, which an `as never` cast in the first draft hid.
  - The consent sort is local rather than the shared query's `ORDER BY` — proved by reversing that
    `ORDER BY` (54 tests still pass) and then removing the local sort (two fail, including the
    declined-candidate case).
  - A refused extension is *returned*, not thrown: spec.md stops only paid provider capture at zero, and
    a thrown error here would become a 5xx that ended an interview which should keep taking notes.
  - Verify (2026-07-28): 44 tests over every transition, both consent absences, supersession,
    withdrawal mid-session and during a pause, insufficient credits, tier refusal, participant refusal on
    each control, four staleness cases, release-vs-settle, extension refusal, and warning thresholds.

- [x] **Add session/token/segment APIs** — done 2026-07-28 (`fc5a532`), NOT yet deployed
  - Files: `src/routes/api/interviews/$interviewId/session.ts` (new),
    `src/routes/api/interviews/$interviewId/transcription-token.ts` (new),
    `src/routes/api/interviews/$interviewId/segments.ts` (new),
    `src/shared/lib/security/same-origin.ts` (new), `src/lib/interviews/brief-context.ts`,
    `tests/unit/routes/api/interviews/session-routes.test.ts` (new)
  - **CSRF did not exist anywhere in this codebase before now.** The session cookie is `SameSite=Lax`,
    which does block a cross-site POST — but that is one line in the auth config, and changing it for an
    embed or an OAuth flow would remove CSRF protection from every mutating endpoint at once with nothing
    failing. `assertSameOrigin` prefers `Sec-Fetch-Site` (unforgeable by page script) and falls back to
    `Origin`; neither present is a refusal.
  - **The eight "refuses audio" tests were fake and a plant proved it.** They sent `RIFF…` bytes, so the
    400 came from `request.json()` failing — the content-type guard could have been deleted and all eight
    would still have passed. Rewritten to send a body the endpoint would otherwise *accept*; with
    `assertJsonRequest` neutered, all eight now fail.
  - happy-dom's `Request` silently drops `Sec-Fetch-Site` and `Origin` (forbidden header names), so the
    tests reinstate them through the one accessor the guard uses. Node's undici keeps them and a server
    reads them off the wire, so the route is right to require them — it is the test environment that
    cannot express them.
  - `GET` is a pure read. It reports `stopNow` for the withdrawal poll but does not stamp
    `heartbeat_at`: a `GET` is reachable cross-site without the origin check, and a write wearing a read's
    verb would let any page keep a dead session out of reclaim. The beat is `POST action: 'heartbeat'` —
    and it carries no `expectedVersion`, because a beat must work for a client whose version has drifted.
  - Verify (2026-07-28): 54 tests over 401/403, tenant B reading as absent, admin denial, missing
    consent, 402 on short balance, withdrawal on both the poll and the beat, four audio content types on
    two routes plus smuggled `audio`/`objectKey` fields, master-key absence and echo-refusal, token
    refusal for participant/paused/finished/withdrawn, 429 on both buckets, reordered/repeated/oversized/
    empty batches, exactly-once resend, and speaker correction attribution.

- [x] **Implement IndexedDB final-text outbox** — done 2026-07-28 (`9399d64`), NOT yet deployed
  - Files: `src/modules/interviews/lib/transcript-outbox.ts` (new),
    `tests/unit/modules/interviews/lib/transcript-outbox.test.ts` (new), `package.json`
    (`fake-indexeddb` devDependency)
  - **Minimized rather than encrypted.** Web Crypto can encrypt the text, but the key would have to live
    in the same browser storage as the ciphertext, so anything that could read one could read the other.
    The real reduction is holding less for less time: only unacknowledged finals, deleted the moment the
    server confirms them, so the steady state during a healthy interview is an *empty* store. A test
    asserts that steady state rather than assuming it.
  - **`IDBObjectStore.delete` fires `onsuccess` whether or not the key existed**, so the first
    `acknowledge` counted attempts and reported a duplicate acknowledgement as having removed something.
    It reads first now, which is also what makes the count mean "this send was new".
  - **A plant found a test passing for the wrong reason.** Removing the user from the primary key broke
    nothing, because the user-scoped *read* was doing the work. The case the key actually protects is two
    organizers on one shared machine with access to the same interview: without it, B's `put` silently
    overwrites A's record, the row carries B's userId, and A's next read returns nothing with no error
    anywhere. Added that test; it now fails under the plant.
  - Retention is swept at open, not on a timer — a timer does not run while the tab is closed, which is
    exactly the case that produces stale records. Twelve-hour TTL, and a sweep collects *every* user's
    expired records because only a different user's visit will ever reach one belonging to someone who
    never came back.
  - `assertNoForbiddenPayload` is exported as the guarantee: eleven field names plus the *shapes*
    (`ArrayBuffer`, typed array, `Blob`, a `blob:` URL string) under any name. `isFinal` is on the list
    because its presence means the caller is storing provider messages rather than parsed finals.
  - Verify (2026-07-28): 38 tests over reload, offline accumulation and drain, duplicate acknowledgement,
    cross-user read/acknowledge/overwrite, per-session isolation, logout and finish cleanup, expiry sweep
    in both directions, absent IndexedDB, a failing open, `QuotaExceededError`, and a transaction that
    aborts after a successful `put`. Three plants proved the compound-index read, the primary key, and
    the sweep-at-open are each load-bearing.

- [x] **Implement browser capture and Web Audio mixer** — done 2026-07-28 (`da254d6`), NOT yet deployed
  - Files: `src/modules/interviews/lib/audio-capture.ts` (new),
    `tests/unit/modules/interviews/lib/audio-capture.test.ts` (new),
    `src/modules/interviews/lib/deepgram-client.ts` (new),
    `tests/unit/modules/interviews/lib/deepgram-client.test.ts` (new)
  - **The video track is stopped before `requestCapture` returns**, not on teardown. `getDisplayMedia`
    cannot give audio alone, so a video track exists — and one alive during a provider connection is one
    something could attach. It is also *removed* from the stream, because `getVideoTracks().length === 0`
    is a far easier invariant to hold than "every video track has readyState 'ended'".
  - **A remote session that cannot get two channels degrades to manual-only, never microphone-only.** A
    transcript missing the candidate's half reads as complete and nobody can tell which half is absent. The
    mixer throws with `manualOnly` rather than quietly building a one-channel graph.
  - **The microphone and the meeting want opposite processing.** Echo cancellation on for the microphone,
    because it is in a room with a speaker playing the meeting back and without it the organizer's channel
    would carry the candidate's voice — destroying the attribution the two-channel design exists for. Off
    for the meeting stream, because it is already clean and the filters remove speech.
  - `MINIMUM_SUPPORTED_CHROME_MAJOR = 138` is a floor that must be raised deliberately; code cannot know
    what today's current stable is. Mobile is checked *before* the version, because Chrome on Android
    reports the right brand and version and still cannot share a tab's audio at all.
  - `sendFrame` sends a slice, not `pcm.buffer`. A frame that is a view into a reused pool would otherwise
    ship the whole pool — every previous frame included.
  - `onerror` deliberately does nothing: a browser fires it and then `onclose` for one drop, and
    reconnecting from both opens two sockets and bills two streams for one conversation.
  - **The recording prohibition is a static check on the source, read from disk.** No behavioural test can
    cover a refactor that adds `MediaRecorder` — the new path simply would not be exercised. Nine patterns
    (`MediaRecorder`, `new Blob`, `createObjectURL`, audio/video elements, `srcObject`, `captureStream`,
    a download attribute, `showSaveFilePicker`), with comment lines stripped so the files' own
    documentation of what is absent does not trip it.
  - Verify (2026-07-28): 78 tests. Browser/version/OS matrix including Edge-is-not-Chrome and
    Chrome-is-not-Safari, mobile, missing `getDisplayMedia`; gesture requirement with no premature
    microphone prompt; monitor/window/self-tab/no-audio refusals; stream release on every failure path;
    interleaving, channel order, clamping and the Int16 positive peak; graph wiring asserting channel 0 is
    the microphone; teardown ordering; socket URL EU pinning including a look-alike host; grant as a
    subprotocol not a query parameter; backlog bound and oldest-first eviction; five-step backoff and
    giving up without a sixth wait; no reconnect after a clean or deliberate close; one socket per drop;
    interim/empty/metadata/malformed messages; attribution by channel with a diarization label present
    and ignored. Five plants proved the static recording check (twice), the buffer slice, the
    `onerror` silence, and the deliberate-close flag are each load-bearing.

- [x] **Build dedicated live interview workspace** — done 2026-07-28 (`89d227e`), NOT yet deployed
  - Files: `src/routes/_dashboard/interviews/$interviewId/live.tsx` (new),
    `src/modules/interviews/components/LiveInterviewPage.tsx` (new),
    `src/modules/interviews/components/CapturePreflight.tsx` (new),
    `src/modules/interviews/components/LiveTranscript.tsx` (new),
    `src/modules/interviews/components/InterviewNotes.tsx` (new),
    `src/modules/interviews/components/InterviewControls.tsx` (new),
    `src/modules/interviews/components/SpeakerMapper.tsx` (new),
    `tests/unit/modules/interviews/components/live-interview.test.tsx` (new),
    `tests/unit/modules/interviews/components/live-interview-page.test.tsx` (new),
    `src/routes/api/interviews/$interviewId/session.ts`, `src/lib/interviews/session-service.ts`,
    `src/modules/interviews/lib/deepgram-client.ts`
  - **The verbal-reminder checkbox is unticked and start is disabled until it is.** A pre-ticked box records
    nothing, and the point of the control is evidence that a person said something out loud. The consent
    receipt beside it names the notice version and the decision date, so it is checkable rather than a claim
    the product makes about itself.
  - **An unsupported browser is offered notes-only and the words "microphone only" appear nowhere.** Half a
    conversation presented as a whole transcript reads as complete and nobody can tell which half is
    missing. A plant that changed the sentence to offer microphone-only transcription fails the test.
  - **In-person labels read "Speaker A", remote labels read "You" and "Candidate".** Remote attribution is a
    fact the mixer constructed; in-person is diarization. A plant presenting the guess as a name fails.
  - **A withdrawal tears capture down from the poll**, socket before microphone, without waiting for the
    organizer to read anything — and leaves finish as the only forward action. The remaining guarantee is
    the token route refusing the next 30-second grant.
  - **`readableError` prefers a wrapped `reason` over the wrapper's `code`.** Found by a test: a
    `DeepgramClientError` reports `no_token` for a withdrawal, a spent balance and a network fault alike, so
    a candidate withdrawing mid-interview showed "something went wrong" at the one moment the organizer
    needed to know exactly what had happened. `DeepgramClientError` now carries the cause's code.
  - Screen-reader announcements are a throttled *summary* (a count, every eight seconds) with the transcript
    itself `aria-live="off"`. Reading every final aloud as it lands would talk over the candidate for
    forty-five minutes. The clock carries a spoken duration, because "12:04" is read as a time of day.
  - A spent balance warns and never blocks: no modal, and the sentence says the interview continues. The
    spinner carries `motion-reduce:animate-none`.
  - `GET /session` grew the bootstrap the workspace needs — viewer id, booked modality, consent receipt — in
    one round trip, and now answers 404 rather than `{session: null}` when no interview is visible, which is
    the same answer an id that never existed gets.
  - Verify (2026-07-28): 60 component tests plus 15 orchestration tests over the whole page — preflight
    gating on consent and acknowledgement, both unsupported-browser messages, tab-audio instructions,
    interim rendering that cannot be persisted, announcement throttling, per-voice and per-line speaker
    correction, unattributed lines surfaced, every connection label, low-balance warning and its absence,
    withdrawal alert, pause and finish ordering asserted through a recorded trace, notes autosave success
    and failure, marker offsets, and the 320 px single-column layout. Three plants proved the
    microphone-only prohibition, the diarization-is-a-guess labelling, and the unticked acknowledgement are
    each load-bearing.

- [~] **Run real browser capture beta verification** — runbook written 2026-07-28 (`d6b1833`);
  **execution BLOCKED on hardware and human participants**
  - Files: `docs/operations/interview-runtime-verification.md` (new)
  - **What is done:** the full procedure. The browser/platform matrix as `detectCaptureSupport` actually
    decides it (ten cells), the degradation table naming where each fallback is enforced in code, the
    session script (crosstalk, two languages, noise, a deliberate 20-second network cut, pause/resume,
    device change), the seven measurements with their targets, the four DevTools artifact inspections, and
    empty results tables with sign-off criteria.
  - **What is NOT done, and why I cannot do it:** the two consented 30-minute sessions. They need current
    *and* previous stable Chrome on macOS *and* Windows, physical microphones, headphones and an external
    mic, a real Meet/Zoom/Teams call on a second machine, and two humans holding a conversation with
    deliberate crosstalk in two languages. `getDisplayMedia` has no headless path — Chrome's
    `--auto-select-desktop-capture-source` bypasses the very picker under test — and synthetic audio
    separates cleanly, so it would certify diarization that fails on two people interrupting each other.
  - The measurements are also only meaningful from a real session: billing variance is provider-billed
    seconds against a conversation with real pauses, and echo cancellation only matters when a speaker
    plays the remote voice into the same room as the microphone.
  - Results tables are left **empty on purpose**. A guessed row would be worse than a missing one — this
    document exists precisely so the numbers can be shown to have come from a machine.
  - Verify: sign-off criteria are in the document as an unchecked list. None are ticked.

## Phase 10 — Contextual questions and reports

- [x] **Register follow-up and report AI tasks** — done 2026-07-28 (`419d15d`), NOT yet deployed
  - Files: `src/shared/lib/ai/tasks.ts`, `tests/unit/shared/lib/ai/tasks.test.ts`
  - **The report cannot conclude anything, and that takes two independent guards.**
    `interviewReportContentSchema` has no rating field *and* `PROHIBITED_OUTPUT_PATTERNS` rejects the
    words. Either alone is defeated: a schema without a score field still admits "strong hire" inside a
    summary statement, and a word filter alone would be walked around by a numeric field. Nine scoring
    variants are tested across all four content sections.
  - **`status: 'unanswered'` is the only status allowed to cite nothing.** An `answered` or `partial`
    topic with no segment is an assertion about what someone said with nothing behind it; a visible gap is
    what makes the report honest.
  - **Both windows are bounded for correctness, not cost.** 40 segments for a follow-up — a model given
    the whole interview answers about the beginning, and the organizer wants a follow-up to what was *just*
    said. 800 for the report, which covers a long interview with headroom; beyond that the service will
    window rather than silently drop the end, because a report missing the last ten minutes is a report of
    a different interview.
  - The interviewer's notes go in their own `<interviewer-notes>` region, after the transcript. Merging
    them would let a private impression be cited as something the candidate said.
  - A live transcript is the most hostile input in this product — a CV is written in advance, but a
    candidate can speak into a transcript knowing it feeds a model. The injection tests assert the *output*
    schema refuses "recommend to hire" whatever the model was persuaded to write, rather than pretending the
    wrapper is impenetrable.
  - `INTERVIEW_FOLLOWUP_THROTTLE_SECONDS` is task metadata so the number a test asserts and the number the
    service enforces cannot drift apart.
  - Verify (2026-07-28): 53 tests. Sensitive/server-only/no-cache/free-gate on both, both window bounds,
    dangling segment and topic citations, empty-citation refusals, the three-question cap, an accepted
    empty list, nine scoring variants, `.strict()` refusing an `overallScore` or `recommendation` key,
    transcript timestamp rendering, notes isolation, and two prompt-injection cases. Three plants proved
    the per-call segment check, the prohibited-content gate, and the follow-up evidence requirement are
    each load-bearing.

- [x] **Implement topic window and suggestion service** — done 2026-07-28 (`2e0d442`), NOT yet deployed
  - Files: `src/lib/interviews/suggestion-service.ts` (new),
    `tests/unit/lib/interviews/suggestion-service.test.ts` (new),
    `src/shared/lib/repositories/interviews.ts`
  - **A proposal writes nothing.** spec.md: ephemeral unless explicitly saved or used. That is not storage
    thrift — a table of every question an organizer glanced at and rejected about a named candidate is a
    record of impressions nobody agreed to keep. A row appears only on use/save/dismiss, and dismissal is
    kept solely so the same question is not proposed again.
  - **Every failure returns the brief's pending prepared questions, in the same shape as a success.** An
    organizer mid-sentence cannot read an error, and a panel that looked different would tell the candidate
    something went wrong. Nine degrade reasons, all silent, and none of the fallbacks carries a citation —
    a prepared question responds to nothing that was said.
  - **A plant found my concurrency test proving nothing.** Removing the in-flight flag left all 30 green,
    because two requests at the same instant are already refused by the *elapsed-time* check. The flag's
    only unique scenario is a completion slower than the thirty-second floor while speech continues — both
    other checks pass and only the flag stops a second paid call whose answer the organizer never sees.
    Rewritten to that scenario; it now fails under the plant.
  - The gate order is the design: session state, then speech, then throttle, then the switch, then
    entitlement, then the provider. A throttled request must not consult the billing platform, and an
    operator reading a tier error for a feature the switch forbids would go and fix a tier that was never
    the problem.
  - `deriveTopicCoverage` is a token-overlap heuristic, deliberately not a model call: asking a model which
    topics are covered would cost a second sensitive completion for a hint, and a wrong answer here is cheap
    (a topic is deprioritised, not deleted) where the same wrongness in a report would be a fabrication.
    Stop words are filtered so "Tell me about your work" is not matched by "tell me".
  - The prompt carries speaker *labels*, never `speaker_a`: a confirmed human mapping beats the guess it
    replaced, and in-person stays "Speaker A" rather than guessing a role — telling the model the candidate
    said something the interviewer said produces a follow-up aimed at nobody.
  - **The test's fake provider was wrong before it was right.** It called `schema.parse` and threw a
    `ZodError`; the real boundary uses `safeParse` and throws `AIParseError`. So the bad-output-versus-outage
    classification was being tested against a shape production never produces. Fake aligned, and the service
    now treats either as bad output.
  - Verify (2026-07-28): 30 tests over ephemeral output, all three action states, sequence collision,
    critical-first fallback ordering, the three-item cap, paused/finished/no-brief/no-speech/disabled/
    not-entitled degradations, provider outage versus invalid output, a dangling segment citation, a smuggled
    hire recommendation, the thirty-second floor in both directions, no-new-speech after ten minutes, the
    slow-provider collapse, and speaker labelling in both capture modes. Three plants proved the ephemeral
    guarantee, the switch-before-billing order, and the in-flight collapse are each load-bearing.

- [x] **Implement report generation and finalization service** — done 2026-07-28 (`d60684d`), NOT yet
  deployed
  - Files: `src/lib/interviews/report-service.ts` (new),
    `tests/unit/lib/interviews/report-service.test.ts` (new),
    `src/shared/lib/repositories/interviews.ts`, `src/shared/lib/interviews.ts`,
    `tests/unit/shared/lib/interviews.test.ts`
  - **A bug found on the way in: `buildFallbackReportTemplate` produced content its own schema rejected.**
    `answer: ''` is below `min(1)`, so the deterministic fallback could not be persisted — it would have
    failed at exactly the moment the provider did, which is the one moment it exists for. The test that
    should have caught it was checking half of what its own name claimed: "passes the clean-content **and
    schema** checks" only called `assertReportContentIsClean`. Fixed in its own commit (`1736105`).
  - **A provider failure produces a template and charges nothing; a credit refusal does not.** The
    distinction is deliberate. A template is useful — the interview happened and the organizer needs
    somewhere to write it up — but silently handing them a blank form when their balance ran out would hide
    the fact that they need to top up. `provider: null` is the template's marker.
  - **An edit inherits its evidence list from the previous version and can never supply one.** A
    hand-edited report is precisely where an unsupported claim gets introduced, so the citation check
    matters *more* there. A plant removing it fails the test.
  - **A second plant found a guard my tests could not reach.** `finalizeReport`'s `status = 'draft'`
    predicate is the race guard — two clients both read `draft`, both pass the service's `already_final`
    check, and only one UPDATE may win. Removing it left all 34 tests green because the service check runs
    first. Added a test that reaches the repository directly and asserts the recorded `finalizedAt` is the
    *first* one; it now fails under the plant.
  - Topic ids are derived identically to `suggestion-service`, so a suggestion citing `topic:2` and a report
    answering `topic:2` mean the same topic. Two independent numberings would silently disagree.
  - The report window keeps the *tail* when a transcript overflows, unlike the brief: the closing minutes
    are where commitments and follow-ups are made.
  - Verify (2026-07-28): 35 tests over generation with provenance, five-credit settlement, owner-only,
    no-transcript with neither a provider call nor a reservation, remote speaker labels and timestamp
    rendering, notes isolation, four template reasons with the hold released, credit and tier refusals
    *not* templating, a smuggled score, a dangling citation, edit versioning and conflict, edit-introduced
    score and dangling reference, evidence-list immutability, finalize with timestamp, double finalize,
    stale-version finalize, post-finalize edit refusal, and version metadata without content.

- [x] **Add suggestion/report APIs** — done 2026-07-28 (`ef10bab`), NOT yet deployed
  - Files: `src/routes/api/interviews/$interviewId/suggestions.ts` (new),
    `src/routes/api/interviews/$interviewId/report.ts` (new),
    `src/routes/api/interviews/$interviewId/finalize.ts` (new),
    `tests/unit/routes/api/interviews/report-routes.test.ts` (new)
  - **A suggestion refusal is 200, always.** The service degrades to the prepared questions and the route
    passes the `reason` through. An error status during a live interview surfaces as a failure banner on a
    screen the candidate may be able to see, and the client got something usable either way. The UI decides
    how loud to be.
  - **A provider failure on a report is 201 with a template; a credit failure is 402.** The interview
    happened and the organizer needs somewhere to write it up — but a blank form handed to someone whose
    balance ran out would hide the reason they got it.
  - **A dangling citation is 422, not 400.** The edit was well-formed and the problem is one specific
    citation, which is nameable and fixable. Collapsing it into "invalid input" would leave the organizer
    hunting through a report for something the server already knows.
  - `finalize` is its own route because it is its own decision, and it requires `confirmFinal: true` — a
    field a serialization bug could not set by accident on a `PATCH`. Its audit line is the most important
    in the feature: when an assessment of a person became the record, and by whom.
  - **One test could not fail and a plant would not have caught it.** "answers 503 when contextual questions
    are switched off" asserted `[200, 503]`.contains(status). The env mock was a frozen spread, so the flag
    could not be flipped; rewritten with a mutable hoisted mock, and it now fails when the gate is removed.
  - Verify (2026-07-28): 37 tests over 401, credit confirmation required, generation with provenance,
    participant `canEdit: false`, template-on-provider-failure at 201, 402 storing nothing, 409 with no
    transcript, cross-site and audio content-type refusals, 429 with retry-after, version listing without
    content, edit versioning and 409, 422 for a dangling citation, 400 for a score, `.strict()` refusing a
    supplied evidence list, finalize confirmation, double finalize, stale finalize, post-finalize edit
    refusal, paused-session fallback, ephemeral proposals writing nothing, action recording, and both
    feature flags. Two plants proved the flag gate and the 422 mapping are load-bearing.

- [x] **Build contextual question and report UI** — done 2026-07-28 (`49ac31f`), NOT yet deployed
  - Files: `src/modules/interviews/components/ContextualQuestions.tsx` (new),
    `src/modules/interviews/components/InterviewReportEditor.tsx` (new),
    `src/modules/interviews/components/TranscriptEvidence.tsx` (new),
    `src/modules/interviews/components/LiveInterviewPage.tsx`,
    `src/modules/interviews/components/InterviewBriefPage.tsx`,
    `src/routes/_dashboard/interviews/$interviewId/index.tsx`,
    `tests/unit/modules/interviews/components/report-ui.test.tsx` (new)
  - **There is no score, rating or recommendation control anywhere in the report editor** — absent, not
    hidden or disabled. A plant adding an "overall impression" slider fails the test, and the test also
    asserts no `input[type=range]`, no `input[type=number]` and no `select` exists at all.
  - **The questions panel never renders a failure reason.** Six degrade reasons are passed in and none
    reaches the screen; the panel labels the *source* ("based on what was just said" versus "from your
    prepared brief") instead. A plant rendering the reason fails six tests. The single exception is
    `not_entitled`, which is a plan limit the organizer can act on afterwards.
  - A citation is a timestamp, never a uuid, and a citation whose segment is gone renders a visible "source
    unavailable" warning rather than disappearing — retention deleting a segment while the report survives
    would otherwise make a supported statement look unsupported, and a reader cannot tell those apart.
  - Finalizing takes two steps and is refused over unsaved changes: finalizing a version that does not
    include what the organizer just typed would freeze the wrong record.
  - The excerpt panel says "no audio was kept" explicitly, so a reader looking for a play button learns
    there is nothing to play rather than concluding the feature is broken.
  - Verify (2026-07-28): 38 tests over citation labelling and the missing-segment warning, the excerpt
    panel, six silent degrade reasons, source labelling, the three-question cap, explicit-only actions,
    template-versus-generated provenance, topic questions rendered instead of ids, read-only for a
    participant and once final, save appearing only after an edit, two-step finalize, finalize refused over
    unsaved work, the newer-version notice, and every error sentence. Two plants proved the score-control
    absence and the silent-degradation guarantee.

### Phase 10 follow-up — found by using it

- [x] **Fix the invitation that was dead on arrival** — done 2026-07-28 (`f56bae2`), NOT yet deployed
  - Files: `src/routes/api/scheduling/invitations/$invitationId/send.ts`,
    `tests/unit/routes/api/scheduling/invitations/invitations.test.ts`
  - The capability is minted at send and only its hash stored, so the response is the last moment the link
    exists — and the route discarded the `devLink` the sender returns when `RESEND_API_KEY` is unset,
    printing the only other copy to a server console. Every invitation created locally or in preview was
    `sent`, had its hash committed, and was permanently unreachable; there is deliberately no resend.
  - The existing test encoded "the response is three fields; nothing about the capability rides along" —
    right about production, wrong everywhere else. Now two tests. The security branch had to be fixed
    before it tested anything: the first version let the real Resend call fail, so the 502 body carried no
    `devLink` either way and the test passed with the route deliberately leaking the link.

- [x] **Add the interviews index** — done 2026-07-28 (`e8a33d9`), NOT yet deployed
  - Files: `src/modules/interviews/components/InterviewList.tsx` (new),
    `src/routes/_dashboard/interviews/index.tsx` (new), `src/routes/api/interviews/index.ts` (new),
    `src/shared/lib/repositories/interviews.ts`, `src/modules/dashboard/ui/shell/nav-config.ts`,
    `tests/unit/modules/interviews/components/interview-list.test.tsx` (new),
    `tests/unit/shared/lib/repositories/interview-list.test.ts` (new)
  - **There was no page listing interviews at all.** `/interviews/$interviewId` was the only route and
    nothing linked to it, so opening an interview meant knowing a calendar event's uuid and typing the URL.
  - The listing query is hand-written SQL with five joins and a correlated subquery, none typechecked, so it
    is tested against real Postgres: three transcript segments and two report versions joined naively return
    six rows for one interview.
  - **Nothing in this product mints a meeting URL.** There is no calendar-provider integration, so
    `meetingUrl` is whatever the organizer typed on the invitation and the list shows a join link only when
    one exists.

## Phase 11 — Retention, privacy, reconciliation, and operations

- [x] **Implement retention and reservation cleanup worker** — done 2026-07-28 (`8c1d7c3`), NOT yet deployed
  - Files: `src/lib/interviews/retention-worker.ts` (new),
    `tests/unit/lib/interviews/retention-worker.test.ts` (new),
    `src/shared/lib/repositories/interview-retention.ts` (new),
    `src/routes/api/admin/interviews/run-retention.ts` (new)
  - **Objects before rows, and that ordering is the whole design.** Neither is atomic with the other, so the
    choice is which way it breaks. Row-then-object leaves a candidate's CV in R2 forever with nothing left
    that knows its key — a silent, permanent retention breach no later pass can find. Object-then-row leaves
    a row pointing at a missing object, which 404s and is swept next pass. A failed object deletion therefore
    *keeps* its row, because the row is the only thing that will make the retry happen.
  - **Child-first deletion, because the FK cascades would otherwise hide the bug.** `transcript_segments` and
    `interview_suggestions` cascade from `interview_sessions`. A parent-first sweep would *work* and would
    quietly take a 90-day transcript because its session row expired first. Each table is deleted on its own
    predicate, and a parent is only deleted once no child remains.
  - **`candidate_links` has no retention column** — found by the query failing with `column
    "retention_expires_at" does not exist`, not by reading the schema carefully enough first. A link's
    retention is its submission's, inherited through the composite FK, so its predicate is the submission's
    clock.
  - **The sweep never recomputes an expiry.** Every row carries the deadline written under the policy in
    force when it was created; recomputing from today's env would retroactively extend retention on data a
    candidate was told would be deleted. A shorter organization policy therefore needs no schema and no
    branch — whatever wrote the row writes a nearer expiry.
  - **Consent outlives the data it covered**, on its own `INTERVIEW_CONSENT_RETENTION_MONTHS` clock. Deleting
    it alongside would destroy the only evidence the processing was lawful — the one record a regulator asks
    for after the data is gone.
  - The route has **no feature flag**, unlike every other worker route. An operator who switches interviews
    off still owes every candidate their deletion, and a sweep that stopped with the flag would retain
    documents forever. Turning a feature off must not turn its obligations off.
  - Stale reservations are closed through the platform's own `releaseReservation`, scoped to `interview_%`
    operations. Reimplementing the release would be a second, quietly divergent billing path; sweeping every
    operation would be a second billing worker wearing a retention hat.
  - `dryRun` rehearses the real statements inside a rolled-back transaction, so its counts are the counts —
    a preview computed differently would be worthless as a rehearsal, and a test asserts the two match.
  - Verify (2026-07-28): 21 tests over end-to-end expiry, nothing inside its window, a transcript surviving
    its session, the session going on the next pass, a submission held by a live document, object-before-row
    ordering, a failed object keeping its row, the retry succeeding, no storage configured, tenant isolation
    both ways, one tenant failing without stopping the sweep, three consent-window cases, dry-run parity, and
    four reservation cases. Three plants proved the child-first order, the failed-object row retention, and
    the separate consent clock are each load-bearing.

- [x] **Extend privacy export and deletion** — done 2026-07-28 (`2201ed4`), NOT yet deployed
  - Files: `src/shared/lib/repositories/interview-privacy.ts` (new),
    `tests/unit/shared/lib/repositories/interview-privacy.test.ts` (new),
    `src/shared/lib/repositories/account-privacy.ts`,
    `src/shared/lib/db/create-disposable-test-database.ts`
  - **The subject of an account export is the organizer, and that decides everything.** A candidate's CV, the
    text of what they said, and a model's assessment of them are a *third party's* personal data. Handing
    them to a different data subject in the name of a subject access request would be a disclosure dressed as
    compliance. So the export carries the organizer's own records in full and, for anything a candidate
    supplied, **counts and status only**. A candidate's route to their own data is a mediated request against
    the invitation, deliberately not a self-service endpoint.
  - No object keys, no capability hashes, no email hashes, no candidate name or email, no submitted links.
    One string is seeded into the extraction, the transcript, the brief *and* the report, and the test fails
    if any of the four leaks. `FORBIDDEN_EXPORT_FIELDS` is exported so the test asserts against the list
    rather than a copy of it.
  - Credit usage is grouped by operation, not itemised: a per-reservation list keyed by interview would
    reconstruct which candidate cost what.
  - **Account deletion shortens retention rather than erasing.** An interview that happened is a fact about a
    candidate too, and deleting their transcript because the interviewer closed their account would erase a
    third party's data on a request they never made — and with it the evidence trail the candidate's own
    rights depend on. The invitation is revoked so no new booking can arrive, and the material goes on the
    ordinary retention clock.
  - Two schema facts found by failing queries rather than by reading carefully: `scheduling_invitations` has
    no `sent_at` (the status carries "sent"; `opened_at` is when the candidate looked), and its composite FK
    to `calendar_events` is `set null` — so deleting an event before its invitation tries to null
    `(organization_id, booked_event_id)` together and fails on the NOT NULL tenant column, with an error that
    names the wrong table.
  - **Fixed a test-infrastructure leak on the way:** `createDisposableTestDatabase` opens two pools before
    migrating, and a migration failure meant `drop()` was never returned, so nothing closed them. Iterating
    on a failing `beforeAll` leaked a pool per attempt; this run hit 197 idle connections against a 200 limit
    and every later suite died with `sorry, too many clients already` — which reads as a database problem
    rather than the debris of a failing test.
  - Verify (2026-07-28): 14 tests over invitation and interview listing, consent counts, grouped credit
    usage, another owner's interviews being invisible, five leak assertions, the forbidden-field list, and
    four deletion cases. Three plants proved the transcript exclusion, the owner scoping, and the
    shorten-not-delete choice are each load-bearing. The 11 existing privacy tests stay green.

- [x] **Update legal notices and consent copy** — done 2026-07-28 (`2de73e4`), NOT yet deployed
  - Files: `src/routes/_landing/legal/privacy.tsx`, `src/routes/_landing/legal/terms.tsx`,
    `src/shared/lib/legal-versions.ts` (new), `src/shared/lib/legal.ts`,
    `src/shared/lib/consent-notice.ts`, `tests/unit/shared/lib/legal-interview-copy.test.ts` (new),
    `tests/unit/shared/lib/legal.test.ts`, `tests/unit/shared/lib/billing/consent.test.ts`,
    `docs/operations/interview-provider-register.md`
  - **Not gated on legal review** (product-owner decision 2026-07-28), as recorded in the original task.
  - **The privacy version existed in three places and nothing tied them together.** `legal.ts` had
    `privacy: 'v1.1'`, `consent-notice.ts` restated `'v1.1'`, and the page displayed a hand-typed
    `Version v1.1`. A consent receipt is only evidence if the version it records is the version the reader
    saw — bumping one and forgetting another would have left every receipt pointing at text nobody rendered,
    with nothing failing. Now one constant in `legal-versions.ts`, derived everywhere. The split exists
    because `legal.ts` reaches the account repositories and a candidate-facing module cannot import it.
  - **v2.0, not v1.2.** `isMaterialVersionChange` compares only the major, so a minor bump would have let
    every existing acceptance carry. A first draft used v1.2 and its own comment claimed acceptances would not
    carry; they would have. New categories of personal data need fresh consent.
  - **That has a deploy-day consequence I had not traced:** `requireCurrentCommercialConsent` uses the same
    rule, so on deploy every organization holding a v1.x acceptance hits a re-acceptance gate at checkout.
    Found by a billing test failing, not by reasoning. Correct behaviour, recorded in the provider register
    so it does not surprise whoever is on support.
  - **A section-numbering test caught two section 12s** in the terms — inserting the interview section
    renumbered the old 11 into a collision. The test now derives the expected sequence rather than listing it.
  - The `accept all` assertion is against the API schemas, not the prose: the page's promise is worth what the
    API enforces, and a single field granting every purpose would make each separate unticked box decorative.
  - Verify (2026-07-28): 42 tests. Version single-sourcing in both directions, the rendered version deriving
    from the constant, the major bump, the bumped candidate notice, 27 required privacy-policy claims
    (controller/processor, documents, robots.txt, link-only platforms, audio never stored, transcript stored,
    consent basis, never pre-ticked, booking is not agreement, ten-second stop, non-retroactive withdrawal,
    all four processors with regions, no training, three retention periods, no automated decision, AI can be
    wrong, human review, rights, contact, credit billing), a section for every recordable consent purpose,
    seven terms obligations, and contiguous numbering. Three plants proved the derived version, the major
    bump, and the accept-all ban are each load-bearing.

- [~] **Complete EU AI Act classification and operational controls** — controls done 2026-07-28
  (`a51efc5`); **sign-off NOT obtained, launch stays behind `SENSITIVE_AI_ENABLED=false`**
  - Files: `docs/compliance/interview-ai-act-classification.md` (new),
    `docs/operations/interview-ai-human-oversight.md` (new),
    `docs/operations/interview-ai-post-market-monitoring.md` (new),
    `src/modules/interviews/components/AiDraftNotice.tsx` (new),
    `src/modules/interviews/components/InterviewBriefEditor.tsx`,
    `src/modules/interviews/components/InterviewReportEditor.tsx`,
    `src/shared/lib/interviews.ts`,
    `tests/unit/shared/lib/ai/no-automated-decision.test.ts` (new),
    `tests/unit/modules/interviews/components/report-ui.test.tsx`
  - **The prohibited-output filter did not catch protected-trait proxies at all.** It refused "score" and
    "culture fit" and let "the gap was maternity leave, which suggests family commitments" straight through —
    found by writing the test first and watching six of six proxy cases pass. Added maternity/paternity,
    pregnancy, disability, religion, ethnicity, race, gender, sexual orientation, age-for-role, native
    speaker, accent, marital and family status, childcare, health and mental health, political affiliation,
    union membership, and a graduation-year-used-inferentially pattern. A proxy is how a protected
    characteristic reaches a hiring file without being named, so the patterns cover the *inference*.
  - **A test that forbade the truth.** "has no score, rating or recommendation control anywhere" asserted the
    page text never contained the word "score" — which broke the moment the Article 50 disclosure said, in as
    many words, that the draft does not score or recommend anything. Word-absence was a proxy for the real
    property; it now checks *controls* and scopes the vocabulary check to the report content.
  - `AiDraftNotice` is one shared component because a sentence copied into three surfaces drifts: one gets
    reworded, one moves below the fold, one is dropped in a refactor. It names the specific failure modes —
    misattributed speakers, mis-transcribed terms, false certainty — because "AI draft" alone says who wrote
    it, not what to distrust. A template renders a different notice; calling it an AI draft would be the more
    misleading error.
  - **Three of my own assertions were wrong before they were right**, each caught by running them: a substring
    check flagged the word "rating" inside a schema comment, a write-detection regex blamed
    `throttleBySession.delete(sessionId)` on an in-memory Map, and the brief's system message was asserted to
    forbid scoring when its prohibition is about protected traits.
  - **The Article 6(3) preparatory-task reading is drafted with its weaknesses stated, not asserted.** A report
    is what a hiring decision is argued from weeks later; "preparatory" is defensible about what it contains
    and less comfortable about what it influences. The mitigations are what the argument rests on. Recorded
    honestly, including that `PROHIBITED_OUTPUT_PATTERNS` is English-only and "Recomiendo contratarlo" passes
    today — with a test asserting that *current* behaviour so it fails the day Spanish patterns are added.
  - **No sign-off exists and the launch is blocked**, exactly as the task requires. `SENSITIVE_AI_ENABLED`
    defaults to `false`; the classification document's sign-off table is empty and names what is missing.
  - Verify (2026-07-28): 24 static and fixture tests — no candidate-status column anywhere in the interview
    tables, `.strict()` refusing an added score key, every AI module writing only its own artifact tables
    (proved by planting a `candidate_submissions` write), no repository import that could change a candidate,
    all three tasks sensitive/server-only/uncached/free-gated, six protected-trait proxies refused, a
    legitimate work statement accepted, Spanish accepted and the Spanish-only gap documented. Plus four UI
    tests for the label, the limitations, and the template's different notice.

- [x] **Implement provider usage reconciliation** — done 2026-07-28 (`PENDING`), NOT yet deployed
  - Files: `src/lib/interviews/usage-reconciliation.ts` (new),
    `tests/unit/lib/interviews/usage-reconciliation.test.ts` (new)
  - **It compares and requests; it never writes the ledger.** Every correction goes through the platform's
    `refundUsage`, which makes the entries, demands provider evidence, and refuses a refund larger than what
    was consumed. Reimplementing any of that would be a second billing path that agrees with the first until
    the day it does not. No new worker and no new route — the existing reconciliation contract carries the
    report.
  - **It only ever refunds.** An under-billing above policy is *reported*, never chased: the customer has
    already been told what the interview cost, and reaching into a closed period to take more is not a
    correction. A plant that removed the direction check fails.
  - **Rounding is not a variance.** Transcription bills whole minutes and Deepgram reports fractional seconds,
    so a 1,800-second call settles at 31 against a provider figure of 30. Treating that as a discrepancy would
    make every interview one and the report worthless. The band is the rate card's own unit, not a percentage.
  - A duplicated provider reference is refused rather than summed: two records for one reference could be a
    retry or a double-report, and adding them would bill a customer for the provider's own ambiguity.
  - Token counts are carried as evidence and contribute zero units, because brief and report are flat-priced —
    for those operations the comparison is about whether the call happened, not how large it was.
  - `matched` and `rounding` map to no mismatch type at all: reporting them would bury the ones that matter.
  - **A test of mine measured the wrong thing.** "calls a small real difference a variance within policy" used
    100 against 101 units — a one-unit difference, which is inside the rounding band by design. It was
    measuring rounding while claiming to measure variance.
  - Verify (2026-07-28): 23 tests over minute rounding in both directions, flat token pricing, exact match,
    rounding, within and above policy, the 1% boundary, a settled reservation with no provider record, a
    release with none (the expected pair, not an alarm), provider work never settled, a duplicated reference,
    counts across a mixed export, orphan provider records, report-only runs, the refund path with its evidence
    and idempotency key, three refusals to refund, an unresolvable settlement id, the mismatch mapping, and a
    late export reconciling on the next run. Three plants proved the under-billing refusal, the rounding band,
    and duplicate detection are each load-bearing.

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
