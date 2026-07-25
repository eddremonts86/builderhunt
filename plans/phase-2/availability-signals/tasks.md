# Availability Signals (Open-to-Work Score) (tasks)

> **Status**: `pending`
> **Depends on**: [`abuse-and-usage-integrity`](../../abuse-and-usage-integrity/spec.md) (the decayed combined-signal scoring mechanics this plan reuses); [`claimable-profiles`](../../claimable-profiles/spec.md) (a subject's explicit open-to-work state always outranks inference); [`legal-and-compliance`](../../legal-and-compliance/spec.md) (inference about named individuals must be disclosed and contestable). Binding: [`security-policy`](../../_meta/security-policy.md).
> **Blocks**: nothing
> **Reality check**: Reuses shipped code — `src/shared/lib/abuse/risk.ts` (decay + corroboration), `src/shared/lib/repositories/enrichment-restrictions.ts` + `is_builder_processing_restricted()` (suppression), `published_builder_profiles.open_to_status` (the subject's own stated status), `src/lib/enrichment/network.ts`'s `safeFetch` (SSRF-safe fetch), `src/routes/api/admin/alerts/run-worker.ts` (worker pattern). `builder_source_snapshots` has no runtime writer and no non-owner grants — Phase 0 fixes that.

## Phase 0 — Bio history: snapshot write path + grants

- [ ] **Grant the runtime roles access to `builder_source_snapshots`**
  - Files: `drizzle/00XX_builder_source_snapshots_grants.sql` (new), `drizzle/meta/_journal.json`,
    `drizzle/meta/00XX_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: mint the empty migration with `pnpm exec drizzle-kit generate --custom` (there is no schema
    change, so plain `db:generate` emits nothing) so the journal entry **and** its matching
    `meta/NNNN_snapshot.json` are created — `scripts/db/verify-migration-integrity.mjs:12-15`
    hard-fails on any SQL file not in `_journal.json` or missing a snapshot, and an un-journaled
    file is never applied by `drizzle-kit migrate`. Then fill the SQL body:
    `REVOKE ALL ON TABLE builder_source_snapshots FROM PUBLIC;`
    `GRANT SELECT, INSERT, DELETE ON TABLE builder_source_snapshots TO builderhunt_app;`
    `GRANT SELECT ON TABLE builder_source_snapshots TO builderhunt_worker;`
    Header comment must state the finding: the only existing writer is the owner-role backfill
    `scripts/db/backfills/builders.ts:110`, so no grant ever existed (same class of gap as
    `drizzle/0025_public_tables_app_grants.sql`). Finally regenerate the hash manifest with
    `node scripts/db/verify-migration-integrity.mjs --write` and commit all four files together.
  - Verify: `pnpm exec drizzle-kit check` and `pnpm test:migration-integrity` both pass (SQL count ==
    journal entries == snapshot count); `pnpm db:migrate` applies it; only then, as
    `builderhunt_app`, `insert into builder_source_snapshots (...) values (...)` succeeds where it
    previously raised `permission denied`.

- [ ] **Add `recordBuilderSourceSnapshot()` + bounded retention trim**
  - Files: `src/shared/lib/repositories/builder-snapshots.ts` (new), `src/shared/lib/repositories/builder-snapshots.test.ts` (new)
  - Do: `recordBuilderSourceSnapshot(tx, { builderIdentityId, payload })` computes
    `contentHash = sha256(canonical JSON of payload)`, inserts with
    `onConflictDoNothing()` on the existing `(builder_identity_id, content_hash)` unique index, then
    deletes all but the newest `AVAILABILITY_SNAPSHOT_KEEP` rows for that identity ordered by
    `observed_at desc`. Payload is public profile fields only: `{ username, displayName, bio,
    profileUrl, followersCount, language, country }`.
  - Verify: `pnpm test builder-snapshots` — re-recording identical content adds no row; 10 distinct
    snapshots leave exactly 8.

- [ ] **Write a snapshot on every track**
  - Files: `src/shared/lib/repositories/organization-builders.ts`
  - Do: in `trackOrganizationBuilder`, after the `builderIdentities` upsert, call
    `recordBuilderSourceSnapshot(transaction, …)` with the same public fields. Same transaction (it
    is already inside `withTenantContext`), but wrapped so a snapshot failure can never fail a
    track — log and continue.
  - Verify: `pnpm test organization-builders`; `POST /api/builders/track` then
    `select count(*) from builder_source_snapshots where builder_identity_id = '<id>'` returns 1.

- [ ] **Add `AVAILABILITY_SNAPSHOT_KEEP` to the env schema**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: `AVAILABILITY_SNAPSHOT_KEEP: z.coerce.number().int().positive().default(8)` beside the
    `DISCOVERY_*` entries, with a comment naming this plan.
  - Verify: `pnpm type-check`; `pnpm test env`.

- [ ] **Prove the snapshot write path under the real non-owner role**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: extend `checkBuilderTracking()` (or add `checkBuilderSourceSnapshots()`) to assert that a
    track as `builderhunt_app` produces exactly one snapshot row and that `builderhunt_app` cannot
    `UPDATE` it.
  - Verify: `pnpm test:api-isolation:local` — check count increases, zero failures.

## Phase 1 — Pure engine: shared decay primitive, detectors, precedence

- [ ] **Extract the decay + corroboration primitive**
  - Files: `src/shared/lib/signal-decay.ts` (new), `src/shared/lib/signal-decay.test.ts` (new)
  - Do: `decayedSum(items: { weight: number; occurredAt: Date }[], now: Date, halfLifeHours: number): number`
    implementing `weight * 0.5 ** (ageHours / halfLifeHours)` with `ageHours <= 0 ⇒ weight`
    (identical to `decayedWeight` in `src/shared/lib/abuse/risk.ts`), and
    `capByCorroboration<T>(ranked: T[], candidate: T, floor: T, distinctTypes: number, minTypes: number): T`
    generalising `computeCandidateRiskStage`'s cap.
  - Verify: `pnpm test signal-decay` — a signal at exactly one half-life weighs half; a future
    `occurredAt` never exceeds its base weight.

- [ ] **Make `abuse/risk.ts` delegate to the primitive with zero behaviour change**
  - Files: `src/shared/lib/abuse/risk.ts`
  - Do: replace the private `decayedWeight` body and the cap expression in
    `computeCandidateRiskStage` with calls to `decayedSum`/`capByCorroboration`. Keep every exported
    name, constant, and signature. **Do not touch `src/shared/lib/abuse/risk.test.ts`.**
  - Verify: `pnpm test src/shared/lib/abuse` passes with `risk.test.ts` byte-unchanged
    (`git diff --stat src/shared/lib/abuse/risk.test.ts` is empty).

- [ ] **Signal types, phrase allowlists, and the pure detectors**
  - Files: `src/shared/lib/availability/signals.ts` (new), `src/shared/lib/availability/signals.test.ts` (new)
  - Do: export `AvailabilitySignalType`, `AVAILABILITY_OPEN_PHRASES`,
    `AVAILABILITY_NEGATION_PHRASES`, `AVAILABILITY_DETECTOR_VERSION = 1`, and pure detectors:
    `detectOpenPhrase(text: string | null): { phrase: string; excerpt: string } | null`
    (case-insensitive, word-boundary, returns null if any negation phrase matches anywhere, excerpt
    trimmed to ≤120 chars), `detectHireable(hireable: boolean | null)`, and
    `detectPhraseAppeared(currentBio, previousBio, previousObservedAt, now, minGapDays = 7)`.
  - Verify: `pnpm test availability/signals` — "not looking for work" ⇒ null; "we are hiring" ⇒
    null; "Open to Work · Berlin" ⇒ excerpt `"Open to Work"`; a 3-day-old previous snapshot ⇒ no
    `open_phrase_appeared`.

- [ ] **Verdict function: decayed score, buckets, corroboration**
  - Files: `src/shared/lib/availability/score.ts` (new), `src/shared/lib/availability/score.test.ts` (new)
  - Do: `AVAILABILITY_WEIGHTS` (`github_hireable: 2`, `profile_text_open_phrase: 3`,
    `open_phrase_appeared: 5`), `AVAILABILITY_HALF_LIFE_DAYS = 45`,
    `AVAILABILITY_PRESENT_MIN_SCORE = 2`, `AVAILABILITY_MIN_CORROBORATING_TYPES = 2`, and
    `computeAvailabilityVerdict(signals, now, opts?): AvailabilityVerdict` using `decayedSum` +
    `capByCorroboration`. `open_signal_recent` requires an `open_phrase_appeared` inside
    `AVAILABILITY_RECENT_WINDOW_DAYS` **and** ≥2 distinct types. No LLM, no I/O, no `Date.now()`.
  - Verify: `pnpm test availability/score` — `github_hireable` alone can never yield
    `open_signal_recent` at any age; empty input ⇒ `no_public_signal` with `scoreBps === 0`.

- [ ] **Precedence resolver + exact disclosure copy + DTO**
  - Files: `src/shared/lib/availability/disclosure.ts` (new), `src/shared/lib/availability/disclosure.test.ts` (new)
  - Do: `resolveAvailabilityDisclosure({ restricted, claim, verdict, signals })` implementing the
    spec's five rules in order. Export `AVAILABILITY_DISCLOSURE_COPY` (the exact sentence),
    `AVAILABILITY_CHIP_COPY` per bucket, and `AVAILABILITY_SIGNAL_LABELS`. Return type is the
    allowlisted DTO — `scoreBps`, `distinctSignalTypes`, and `detectorVersion` are **not** fields on
    it.
  - Verify: `pnpm test availability/disclosure` — `restricted: true` returns exactly the same object
    as "no signals"; `openToStatus: ['nothing']` + a strong verdict returns `null`;
    `openToStatus: ['hires']` returns `stated_by_subject` with no `bucket` key; a type-level test
    asserts the DTO has no numeric score field.

## Phase 2 — Schema, grants, data classification

- [ ] **Add the three tables to the Drizzle schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/00XX_availability_signals_tables.sql` (new),
    `drizzle/meta/_journal.json`, `drizzle/meta/00XX_snapshot.json` (new),
    `drizzle/migration-hashes.json`
  - Do: add `availabilitySignals`, `builderAvailabilityScores`, `availabilityRefreshQueue` exactly
    as written in `spec.md` §"Data class and storage", in a new commented section naming this plan.
    `availability_refresh_queue` has **no `organization_id`** — the comment must say why (cross-tenant
    interest leak). `builder_availability_scores.bucket` CHECK allows only
    `('open_signal_present','open_signal_recent')`. Run `pnpm db:generate`, rename the auto-generated
    tag and update the matching `_journal.json` entry (this repo's rename convention, see
    `plans/abuse-and-usage-integrity/tasks.md`'s `0043` progress note), then
    `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: the generated SQL has three `CREATE TABLE`s and no unexpected diff;
    `pnpm exec drizzle-kit check` and `pnpm test:migration-integrity` pass; `pnpm db:migrate` applies
    it cleanly.

- [ ] **Hand-append the grants migration**
  - Files: `drizzle/00XX_availability_signals_grants.sql` (new), `drizzle/meta/_journal.json`,
    `drizzle/meta/00XX_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: mint it with `pnpm exec drizzle-kit generate --custom` (grants-only, so plain `db:generate`
    emits nothing) so the journal entry and its matching snapshot exist — an un-journaled SQL file
    fails `scripts/db/verify-migration-integrity.mjs:12-15` and is never applied by
    `drizzle-kit migrate`; `0045_user_devices_worker_read_grant` went red on `master` exactly this
    way. Then mirror `drizzle/0044_abuse_usage_integrity_rls_grants.sql`'s structure and comment
    density. No RLS (no owning-subject column — same posture as `abuse_signals`). Grants:
    `REVOKE ALL ... FROM PUBLIC` on all three;
    `GRANT SELECT ON availability_signals, builder_availability_scores TO builderhunt_app;`
    `GRANT SELECT, INSERT ON availability_refresh_queue TO builderhunt_app;`
    `GRANT SELECT, INSERT, UPDATE, DELETE ON availability_signals, builder_availability_scores,
    availability_refresh_queue TO builderhunt_worker;`
    `GRANT SELECT, DELETE ON availability_signals, builder_availability_scores TO builderhunt_platform;`
    No grants for `builderhunt_auth`, no `TRUNCATE`, no `REFERENCES`. Comment must state that the app
    role deliberately cannot write an inference about a person. Finish with
    `node scripts/db/verify-migration-integrity.mjs --write` and commit all four files together.
  - Verify: `pnpm test:migration-integrity` passes (SQL count == journal entries == snapshots) and
    `pnpm db:migrate` applies it; then as `builderhunt_app`,
    `insert into builder_availability_scores …` raises `permission denied`, and as
    `builderhunt_worker` it succeeds.

- [ ] **Register the data classes**
  - Files: `scripts/db/audit-schema.ts`, `docs/architecture/data-classification.md`
  - Do: `operational('availability_signals', 'builder_identity_id', ['availability-signals'])`,
    `operational('availability_refresh_queue', 'builder_identity_id', ['availability-signals'])`, and
    `global('builder_availability_scores', ['builder_identity_id', 'bucket', 'computed_at'], ['availability-signals'])`.
    In the doc, annotate the scores row: *derived inference about an identified natural person;
    publication forbidden; read requires an entitlement; subject-suppressible*.
  - Verify: `pnpm tsx scripts/db/audit-schema.ts` reports zero unclassified tables.

- [ ] **Add the feature env vars**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: `AVAILABILITY_SIGNALS_ENABLED: z.enum(['true','false']).default('false')`,
    `AVAILABILITY_IDENTITIES_PER_RUN` (50), `AVAILABILITY_DAILY_FETCH_CAP` (500),
    `AVAILABILITY_SIGNAL_RETENTION_DAYS` (180), `AVAILABILITY_HALF_LIFE_DAYS` (45),
    `AVAILABILITY_RECENT_WINDOW_DAYS` (30), `AVAILABILITY_LEASE_SECONDS` (120). All optional with
    safe defaults; disabled by default, matching `ENRICHMENT_ENABLED`.
  - Verify: `pnpm test env`; `pnpm type-check`; app boots with none of them set.

## Phase 3 — Collector, worker, admin endpoint, suppression enforcement

- [ ] **Repository for signals, scores, and the queue**
  - Files: `src/shared/lib/repositories/availability-signals.ts` (new), `src/shared/lib/repositories/availability-signals.test.ts` (new)
  - Do: worker-role functions taking an injectable `db` (same convention as
    `repositories/abuse-signals.ts`): `enqueueAvailabilityRefresh(identityId)` (app role,
    `onConflictDoNothing`), `leaseAvailabilityQueue(limit, leaseSeconds)`,
    `upsertAvailabilitySignal(input)` (conflict target
    `(builderIdentityId, signalType, contentHash)`), `deleteAvailabilitySignalsByType(identityId, types)`,
    `listLiveAvailabilitySignals(identityId)` (`expiresAt > now()`),
    `upsertAvailabilityScore(...)` / `deleteAvailabilityScore(identityId)`,
    `purgeExpiredAvailabilitySignals(limit)`, and
    `purgeAvailabilityForIdentity(identityId)` (signals + score + queue row).
  - Verify: `pnpm test repositories/availability-signals` against a disposable database — a repeated
    upsert of identical content leaves exactly one row.

- [ ] **GitHub availability collector**
  - Files: `src/lib/availability/collector.ts` (new), `src/lib/availability/collector.test.ts` (new)
  - Do: `collectGithubAvailability(target: { username: string })` calls
    `safeFetch('https://api.github.com/users/<login>')` with `allowedHosts` from
    `getSourcePolicy('github')` (`src/lib/enrichment/policies.ts`), the `ENRICHMENT_USER_AGENT`
    default, and the optional `GITHUB_TOKEN` — exactly as `src/lib/enrichment/connectors/github.ts`
    does — and returns `{ hireable: boolean | null; bio: string | null; profileUrl: string }`.
    Map `SafeFetchError` codes to `{ kind: 'retry' | 'no_data' | 'stop' }` like that connector.
    Non-GitHub sources contribute **no fetch** — they use the stored `builder_identities.bio`.
  - Verify: `pnpm test availability/collector` with a stubbed `safeFetch` — 404 ⇒ `no_data`,
    `rate_limited` ⇒ `retry` with a `retryAt`.

- [ ] **The worker**
  - Files: `src/lib/availability/worker.ts` (new), `src/lib/availability/worker.test.ts` (new)
  - Do: `runAvailabilityWorker()`. Returns `{ disabled: true }` when
    `AVAILABILITY_SIGNALS_ENABLED !== 'true'`. Otherwise: purge expired signals; lease ≤
    `AVAILABILITY_IDENTITIES_PER_RUN` rows by `availableAt asc`; per identity, own transaction —
    (1) `select is_builder_processing_restricted($1)`, if restricted `purgeAvailabilityForIdentity`
    and drop the queue row; (2) collect S1/S2/S3 (S3 from the two newest snapshots ≥7 days apart);
    (3) upsert present signals and **delete now-absent S2/S3 rows in the same transaction**;
    (4) `computeAvailabilityVerdict` → upsert or delete the score row; (5) drop the queue row. Daily
    fetch cap via a Redis `availability:fetches:<YYYY-MM-DD>` counter with the in-memory fallback
    from `src/lib/discovery/worker.ts`; on cap return `capped: true` and leave rows queued. A
    per-identity error bumps `attempts`, sets `lastErrorCode` + `availableAt = now() + backoff`, and
    never aborts the run.
  - Verify: `pnpm test availability/worker` — running twice over the same identity produces identical
    rows (idempotent); a restricted identity ends with zero signal, score, and queue rows; a removed
    bio phrase deletes the S2 row and the score row.

- [ ] **Admin run-worker endpoint**
  - Files: `src/routes/api/admin/availability-signals/run-worker.ts` (new)
  - Do: clone `src/routes/api/admin/alerts/run-worker.ts` verbatim in structure —
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, call
    `runAvailabilityWorker()`, `auditPlatformAdminAction({ action: 'admin.worker.run', targetType:
    'worker', targetId: 'availability-signals', result: 'allowed' })`, return
    `Response.json({ ok: true, ...result })`, `platformAdminErrorResponse(err)` fallback.
  - Verify: `curl -X POST -H 'Cookie: <admin session>' localhost:3000/api/admin/availability-signals/run-worker`
    returns `{ ok: true, disabled: true }` with the flag unset; an unauthenticated call returns 401.

- [ ] **Extend the existing subject-restriction cascade**
  - Files: `src/lib/enrichment/worker.ts`
  - Do: in `cascadeBuilderProcessingRestriction` (line ~206), after the enrichment purges, call
    `purgeAvailabilityForIdentity(builderIdentityId)` and include
    `availabilitySignalsPurged` / `availabilityScorePurged` in the returned counts and the
    `enrichment_subject_restriction` log line.
  - Verify: `POST /api/me/builder/$builderId/restrict-processing` as a verified claimant returns the
    new counters and leaves zero availability rows for that identity.

- [ ] **Document the collector in the source register**
  - Files: `docs/operations/public-enrichment-source-register.md`
  - Do: add an entry for the availability collector: official GitHub REST API only
    (`GET /users/{login}`), fields read (`hireable`, `bio`), no HTML scraping, no third-party
    aggregators, retention `AVAILABILITY_SIGNAL_RETENTION_DAYS`, subject controls, and the fact that
    it is gated behind its own flag rather than `ENRICHMENT_ENABLED`.
  - Verify: the register lists every host the availability collector can reach and matches
    `getSourcePolicy('github').allowedHosts`.

## Phase 4 — Subject-facing surface first

- [ ] **Subject read endpoint**
  - Files: `src/routes/api/me/builder/$builderId/availability.ts` (new)
  - Do: `GET`. `requireTenantPrincipal` → `withTenantContext(principal, tx =>
    isVerifiedBuilderClaimant(tx, principal.userId, params.builderId))`, 403 otherwise — the exact
    gate used by `src/routes/api/me/builder/$builderId/evidence-provenance.ts`. Return the same DTO
    recruiters get, plus `suppression: { setNotLooking: 'PATCH /api/me/builder/<id>', restrictProcessing: 'POST /api/me/builder/<id>/restrict-processing' }`.
  - Verify: a non-claimant gets 403; a claimant gets the identical `availability` object the
    recruiter endpoint returns for the same identity (asserted in the isolation script).

- [ ] **Subject card on `/me`**
  - Files: `src/routes/_dashboard/me/index.tsx`, `src/modules/builder-profile/components/AvailabilityDisclosureCard.tsx` (new)
  - Do: build `AvailabilityDisclosureCard` (shared by both surfaces) rendering the chip copy, the
    exact `AVAILABILITY_DISCLOSURE_COPY` sentence, and one row per signal
    (`<label> · seen <date> · <source>` + excerpt + link). On `/me`, render it under each claimed
    profile with the heading "What recruiters can see" and a one-click button that PATCHes
    `openToStatus: ['nothing']`. Renders nothing when `availability` is `null`.
  - Verify: with `openToStatus: []` and a seeded signal, the card shows the bucket chip; clicking the
    button re-fetches and the card disappears.

## Phase 5 — Recruiter surface, entitlement gate, forbidden-pattern tests

- [ ] **Recruiter read endpoint with the entitlement gate**
  - Files: `src/routes/api/builders/$builderId/availability.ts` (new)
  - Do: `GET`. `requireTenantPrincipal` → `can(principal, 'resource:read')` →
    `findOrganizationBuilderByIdentity(tx, principal.organizationId, params.builderId)` (404 if not
    tracked, same shape as the other `$builderId` routes) →
    `getOrganizationEntitlement(tx, principal.organizationId)`; require
    `policy.paidActionsAllowed && ['pro','pro_max','team'].includes(policy.tier)` else
    `403 { error: 'plan' }`. Then `enqueueAvailabilityRefresh(identityId)` when the score row is
    missing or `computedAt` is older than 7 days (rate-limited via
    `rateLimit('availability-enqueue', getAuthedRateLimitId({...}), 30, 60)`), and return
    `resolveAvailabilityDisclosure(...)`. Returns `{ availability: null }` whenever
    `AVAILABILITY_SIGNALS_ENABLED !== 'true'`.
  - Verify: `curl` as a free-tier org ⇒ 403 `plan`; as a pro org for an untracked identity ⇒ 404; as
    a pro org for a tracked identity with no signals ⇒ `{ "availability": null }`; the response body
    contains no `scoreBps`/`score`/`percent` key.

- [ ] **Recruiter panel in the builder profile**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: fetch `/api/builders/${builderId}/availability` alongside the existing profile/notes/session
    fetches and render `AvailabilityDisclosureCard`. Keep the existing
    `builder.isClaimed && builder.openToStatus` block (line ~206) as the `stated_by_subject` path —
    do not duplicate it. On a 403 with `error: 'plan'`, render the static unconditional
    "Availability signals — Pro" row that looks identical whether or not signals exist.
  - Verify: in the browser, a pro org sees the chip + expandable disclosure with the source link; a
    free org sees the identical upsell row for a builder with signals and for one without.

- [ ] **Add the feature to the Pro plan copy**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: add `'Public availability signals'` to `PLAN_PRICING.pro.features`. No `PLAN_LIMITS` entry —
    it is a boolean capability, like semantic search.
  - Verify: `pnpm test billing`; `/pricing` lists it under Pro.

- [ ] **Test the forbidden surfaces**
  - Files: `src/routes/api/export/builders.ts`, `src/shared/lib/availability/disclosure.test.ts` (from Phase 1)
  - Do: add assertions that no availability field appears in the CSV export header or rows, in
    `api/feeds/$searchId.xml`, in any Resend template, or in the outreach draft body
    (`src/shared/lib/outreach.ts`); and a test asserting the exported DTO type has no numeric field
    and no `'no_public_signal'` value reachable from the API.
  - Verify: `pnpm test export` and `pnpm test availability/disclosure` pass; `grep -ri availability
    src/routes/api/export src/routes/api/feeds` returns nothing.

- [ ] **Route-level isolation and suppression checks against the real roles**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: add `checkAvailabilitySignals()` — (1) org A cannot read availability for an identity only
    org B tracks (404, no existence leak); (2) a free-tier org gets 403 `plan`; (3) an identity with
    an active `builder_processing_restrictions` row returns a response byte-identical to a
    no-signal identity; (4) `builderhunt_app` cannot INSERT/UPDATE `availability_signals` or
    `builder_availability_scores`; (5) `availability_refresh_queue` has no `organization_id` column;
    (6) the subject and recruiter endpoints return the same `availability` object. Register it in the
    runner list beside `checkEnrichmentAndEvidence()`.
  - Verify: `pnpm test:api-isolation:local` — all new checks pass, total check count increases.

- [ ] **Admin purge endpoint (the rollback lever)**
  - Files: `src/routes/api/admin/availability-signals/purge.ts` (new)
  - Do: `POST`, `requirePlatformAdminPrincipal` only (no cron principal — this is destructive),
    body `{ builderIdentityId?: string }`; with an id it calls `purgeAvailabilityForIdentity`, without
    one it deletes all rows from both tables. Audited via `auditPlatformAdminAction` with
    `action: 'admin.availability.purge'`.
  - Verify: a purge returns the deleted counts and `select count(*)` on both tables is 0; a
    non-admin session returns 403.

- [ ] **Observability**
  - Files: `src/lib/availability/worker.ts` (from Phase 3)
  - Do: emit `log.info('availability_worker_run', { leased, signalsWritten, signalsDeleted,
    scoresWritten, scoresDeleted, restrictedSkipped, expired, fetches, capped, errors })` and
    `log.warn('availability_fetch_cap_reached', …)`. Never log a bio, an excerpt, a username, or a
    source URL — identity references are `builderIdentityId` only.
  - Verify: run the worker locally with the flag on and confirm the log line contains no personal
    text.

## Phase 6 — Optional AI explanation rung (droppable)

- [ ] **Register the `availability-explain` task**
  - Files: `src/shared/lib/ai/tasks.ts`
  - Do: `tier: 'local-first'`;
    `inputSchema: z.object({ bucket: z.enum(['open_signal_present','open_signal_recent']), signals: z.array(z.object({ label: z.string(), source: z.string(), observedAt: z.string() })).min(1).max(4) })`
    — structured metadata only, no subject text, so no `wrapUntrusted` is needed;
    `outputSchema: z.object({ summary: z.string().min(1).max(280) })`;
    `cacheTtlSeconds: 604800`; `allowances: { free: 0, pro: 50, team: 200 }`;
    `maxOutputTokens: 300`. System prompt: one sentence, describe only the listed observations and
    their dates, never assert the person is looking for work, never mention or infer an employer,
    never add a fact not in the input.
  - Verify: `pnpm test ai/tasks` — the task is registered, free allowance is 0, and a model output
    over 280 chars fails schema validation.

- [ ] **Wire the sentence into the disclosure card**
  - Files: `src/modules/builder-profile/components/AvailabilityDisclosureCard.tsx` (from Phase 4)
  - Do: call `ai('availability-explain', …)` only when the card is expanded, render the sentence
    above the signal list prefixed "AI summary of the signals below:", and **hide it entirely** on
    any failure, disabled flag, or exhausted allowance. The structured signal list never depends on it.
  - Verify: with `AI_DISABLED=true` the card renders identically minus the sentence; with the task
    stubbed to throw, no error surfaces in the UI.
