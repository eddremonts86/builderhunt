# Availability Signals (Open-to-Work Score) (tasks)

> **Status**: `pending`
> **Depends on**: [`abuse-and-usage-integrity`](../../phase-1/32-abuse-and-usage-integrity/spec.md) (the decayed combined-signal scoring mechanics this plan reuses); [`claimable-profiles`](../../phase-1/36-claimable-profiles/spec.md) (a subject's explicit open-to-work state always outranks inference); [`legal-and-compliance`](../../phase-1/04-legal-and-compliance/spec.md) (inference about named individuals must be disclosed and contestable). Binding: [`security-policy`](../../_meta/security-policy.md), [`ai-policy`](../../_meta/ai-policy.md), [`conventions`](../../_meta/conventions.md).
> **Blocks**: nothing
> **Reality check**: Reuses shipped code — `src/shared/lib/abuse/risk.ts` (decay + corroboration), `src/shared/lib/repositories/enrichment-restrictions.ts` + `is_builder_processing_restricted()` (suppression), `published_builder_profiles.open_to_status` (the subject's own stated status), `src/lib/enrichment/network.ts`'s `safeFetch` (SSRF-safe fetch), `src/routes/api/admin/alerts/run-worker.ts` + `withJobRun` + `OPERATIONAL_SCHEDULES` (worker pattern). `builder_source_snapshots` has no runtime writer and no non-owner grants — Phase 0 fixes that. Read `spec.md` §Naming before creating any file: an unrelated tenant-private `availability_*` scheduling domain already exists.

**Migration numbering — read once, applies to every migration task below.** Never hardcode a
migration index. `drizzle/meta/_journal.json` is the source of truth for the next one, and the head
moves constantly (86 entries at the time of writing). Every migration task here mints its file with
`pnpm exec drizzle-kit generate --custom` (or `pnpm db:generate` where there is a real schema diff),
which allocates the index, writes the journal entry **and** the matching
`drizzle/meta/NNNN_snapshot.json`. `scripts/db/verify-migration-integrity.mjs:12-15` hard-fails on
any SQL file missing from `_journal.json` or missing a snapshot, and `drizzle-kit migrate` never
applies an un-journaled file. Finish every migration task with
`node scripts/db/verify-migration-integrity.mjs --write` and commit SQL + journal + snapshot +
`drizzle/migration-hashes.json` together.

## Phase 0 — Bio history: snapshot write path + grants

- [ ] **Grant the runtime roles access to `builder_source_snapshots`**
  - Files: `drizzle/<next>_builder_source_snapshots_grants.sql` (new),
    `drizzle/meta/_journal.json`, `drizzle/meta/<next>_snapshot.json` (new),
    `drizzle/migration-hashes.json`
  - Do: mint the empty migration with `pnpm exec drizzle-kit generate --custom` (there is no schema
    change, so plain `db:generate` emits nothing). Fill the SQL body:
    `REVOKE ALL ON TABLE builder_source_snapshots FROM PUBLIC;`
    `GRANT SELECT, INSERT, DELETE ON TABLE builder_source_snapshots TO builderhunt_app;`
    `GRANT SELECT ON TABLE builder_source_snapshots TO builderhunt_worker;`
    No `UPDATE` for anyone (snapshots are immutable observations), no `TRUNCATE`, no `REFERENCES`,
    no grant for `builderhunt_platform`, `builderhunt_auth`, `builderhunt_capability`, or
    `builderhunt_readonly`. `DELETE` for the app role is required by the retention trim in the next
    task, which runs inside the app-role track transaction. Header comment must state the finding:
    the only existing writer is the owner-role backfill `scripts/db/backfills/builders.ts:110`, so
    no grant ever existed (same class of gap as `drizzle/0025_public_tables_app_grants.sql`), and
    must name the three phase-2 plans waiting on it (`browser-extension-overlay`,
    `match-evidence-panel`, `talent-market-intelligence`) so nobody mints a second grants migration.
  - Verify: `pnpm test:migration-integrity` prints `{"valid":true,...}`; `pnpm db:migrate` applies
    it; then, connected as `builderhunt_app`,
    `insert into builder_source_snapshots (builder_identity_id, content_hash, payload) values (…)`
    succeeds where it previously raised `permission denied`, and
    `update builder_source_snapshots set content_hash = 'x'` still raises `permission denied`.

- [ ] **Add `BUILDER_SNAPSHOT_KEEP` to the env schema**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: `BUILDER_SNAPSHOT_KEEP: z.coerce.number().int().positive().default(8)` beside the
    `DISCOVERY_*` entries (`env.ts:113-114`), with a comment saying it bounds
    `builder_source_snapshots` per identity and is deliberately **not** named `AVAILABILITY_*`
    because Phase 0 outlives this feature.
  - Verify: `pnpm type-check`; `pnpm test -- tests/unit/shared/lib/env.security.test.ts`; the app
    boots with the variable unset.

- [ ] **Add `recordBuilderSourceSnapshot()` + bounded retention trim**
  - Files: `src/shared/lib/repositories/builder-snapshots.ts` (new),
    `tests/unit/shared/lib/repositories/builder-snapshots.test.ts` (new)
  - Do: `recordBuilderSourceSnapshot(transaction: TenantTransaction, input: { builderIdentityId: string; payload: SnapshotPayload })`.
    `contentHash = sha256(canonical JSON of payload)` — sort keys, drop `undefined`, so the hash is
    stable across call sites. Insert into `builderSourceSnapshots` with `.onConflictDoNothing()` on
    the existing `builder_source_snapshots_identity_hash_unique` index, then delete all but the
    newest `env.BUILDER_SNAPSHOT_KEEP` rows for that identity ordered by `observed_at desc`
    (`delete … where id in (select id … order by observed_at desc offset $keep)`). `SnapshotPayload`
    is public profile fields only: `{ username, displayName, bio, profileUrl, followersCount,
    language, country }` — no tenant data, no private metadata. The function takes the caller's
    transaction and never imports a db client of its own (`security-policy.md` rule 5).
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/builder-snapshots.test.ts` against a
    disposable database (`createDisposableTestDatabase`, same setup as
    `tests/unit/shared/lib/repositories/abuse-signals.test.ts:1-18`) — re-recording identical
    content adds no row; 10 distinct payloads leave exactly 8 rows.

- [ ] **Write a snapshot on every track**
  - Files: `src/shared/lib/repositories/organization-builders.ts`
  - Do: in `trackOrganizationBuilder` (line 274), immediately after the `builderIdentities`
    `onConflictDoUpdate` (lines 282–294), call `recordBuilderSourceSnapshot(transaction, {
    builderIdentityId: identityId, payload: { username, displayName, bio, profileUrl,
    followersCount, language, country } })` using the same values just written. Same transaction (it
    is already inside `withTenantContext`), but wrapped in `try/catch` that logs and continues — a
    snapshot failure must never fail a track. Note in a comment that this is the **only** runtime
    writer of that table and that `plans/phase-2/availability-signals` Phase 0 owns it.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/organization-builders.test.ts`;
    `pnpm security:boundaries` passes; after a `POST /api/builders/track`,
    `select count(*) from builder_source_snapshots where builder_identity_id = '<id>'` returns 1,
    and tracking the same unchanged builder again still returns 1.

- [ ] **Prove the snapshot write path under the real non-owner role**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: extend `checkBuilderTracking()` (line 288) or add `checkBuilderSourceSnapshots()` and
    register it in the runner list (lines 1225+). Assert, connected as the real `builderhunt_app`
    role: a track produces exactly one snapshot row; a second identical track produces no second
    row; `UPDATE builder_source_snapshots` raises `permission denied`; `builderhunt_worker` can
    `SELECT` it and cannot `INSERT`.
  - Verify: `pnpm test:api-isolation:local` — total check count increases, zero failures.

## Phase 1 — Pure engine: shared decay primitive, detectors, precedence

- [ ] **Extract the decay primitive (only the decay primitive)**
  - Files: `src/shared/lib/signal-decay.ts` (new), `tests/unit/shared/lib/signal-decay.test.ts` (new)
  - Do: export exactly one function —
    `decayedSum(items: { weight: number; occurredAt: Date }[], now: Date, halfLifeHours: number): number`
    implementing `weight * 0.5 ** (ageHours / halfLifeHours)` with `ageHours <= 0 ⇒ weight`,
    identical to the private `decayedWeight` at `src/shared/lib/abuse/risk.ts:51-55`. It returns the
    **unrounded** sum; `computeDecayedRiskScore` applies its own `Math.round` at the call site
    (`risk.ts:66`) and must keep doing so. Do **not** add a `capByCorroboration` helper — `spec.md`
    §Reuse vs. new records why that extraction was rejected.
  - Verify: `pnpm test -- tests/unit/shared/lib/signal-decay.test.ts` — a weight-4 item at exactly
    one half-life sums to 2; a future `occurredAt` never exceeds its base weight; an empty array
    returns 0.

- [ ] **Make `abuse/risk.ts` delegate to the primitive with zero behaviour change**
  - Files: `src/shared/lib/abuse/risk.ts`
  - Do: replace the body of the private `decayedWeight` / the `reduce` in `computeDecayedRiskScore`
    (lines 51-67) with a single `Math.round(decayedSum(signals.map(s => ({ weight:
    SEVERITY_WEIGHT[s.severity], occurredAt: s.occurredAt })), now, halfLifeHours))`. Keep every
    exported name, constant, default parameter, and signature. Leave
    `computeCandidateRiskStage`'s corroboration ternary (lines 91-95) untouched.
    **Do not touch `tests/unit/shared/lib/abuse/risk.test.ts`.**
  - Verify: `pnpm test -- tests/unit/shared/lib/abuse` passes and
    `git diff --stat tests/unit/shared/lib/abuse/risk.test.ts` is empty; `pnpm type-check`.

- [ ] **Signal types, allowlists, and the pure detectors**
  - Files: `src/shared/lib/availability-signals/signals.ts` (new),
    `tests/unit/shared/lib/availability-signals/signals.test.ts` (new)
  - Do: export `AvailabilitySignalType`, `AVAILABILITY_OPEN_PHRASES`,
    `AVAILABILITY_NEGATION_PHRASES`, `AVAILABILITY_BIO_SOURCE_ALLOWLIST =
    ['github','reddit','bluesky','hashnode','codeberg','sourcehut','producthunt','hn']`,
    `AVAILABILITY_DETECTOR_VERSION = 1`, and pure detectors:
    - `isSubjectAuthoredBio(source: string, bio: string | null): boolean` — false unless `source` is
      in the allowlist, and false for `source === 'hn'` when the bio matches `/^Posted: "/` (that is
      `src/lib/sources/hn.ts:123`'s synthesized fallback, not the person's words).
    - `detectOpenPhrase(source: string, text: string | null): { phrase: string; excerpt: string } | null`
      — returns null unless `isSubjectAuthoredBio`; case-insensitive, word-boundary
      (`new RegExp(\`\\\\b${escaped}\\\\b\`, 'i')`, with `#opentowork` matched literally since `#`
      is not a word character); returns null if **any** negation phrase matches anywhere; excerpt is
      the match plus surrounding context trimmed to ≤120 chars.
    - `detectHireable(hireable: boolean | null): boolean` — true only for a literal `true`.
    - `detectPhraseAppeared({ source, currentBio, previousBio, previousObservedAt, now, minGapDays = 7, maxGapDays = 90 })`
      → `{ excerpt: string; priorObservedAt: Date } | null`. Fires only when the current bio yields
      a phrase, the previous bio does not, and `minGapDays <= (now - previousObservedAt) <= maxGapDays`.
      The `maxGapDays` bound exists because `builder_source_snapshots` de-duplicates on content hash,
      so `previousObservedAt` is "first seen with that content" and can be arbitrarily old.
  - Verify: `pnpm test -- tests/unit/shared/lib/availability-signals/signals.test.ts` —
    `"not looking for work"` ⇒ null; `"we are hiring"` ⇒ null; `('github', "Open to Work · Berlin")`
    ⇒ excerpt containing `"Open to Work"`; `('stackoverflow', "87% accept rate, open to work")` ⇒
    null (source not allowlisted); `('hn', 'Posted: "open to work"')` ⇒ null; a 3-day-old previous
    snapshot ⇒ no `open_phrase_appeared`; a 200-day-old one ⇒ no `open_phrase_appeared`.

- [ ] **Verdict function: decayed score, buckets, recency**
  - Files: `src/shared/lib/availability-signals/score.ts` (new),
    `tests/unit/shared/lib/availability-signals/score.test.ts` (new)
  - Do: export `AvailabilityBucket`, `AVAILABILITY_WEIGHTS` (`github_hireable: 2`,
    `profile_text_open_phrase: 3`, `open_phrase_appeared: 5`), `AVAILABILITY_HALF_LIFE_DAYS = 45`,
    `AVAILABILITY_RECENT_WINDOW_DAYS = 30`, `AVAILABILITY_PRESENT_MIN_SCORE = 2`, and
    `computeAvailabilityVerdict(signals, now, opts?: { halfLifeDays?: number; recentWindowDays?: number }): AvailabilityVerdict`.
    Implement exactly the formula inlined in `spec.md` §"Buckets, weights, and the exact formula":
    `score = decayedSum(...)` unrounded, `scoreBps = Math.round(score * 100)`,
    `open_signal_recent` requires an `open_phrase_appeared` whose age ≤ `recentWindowDays` **and**
    `distinctSignalTypes >= 2`; else `open_signal_present` when `score >= 2`; else
    `no_public_signal`. `topSignalType` is the highest decayed value, ties broken by weight then
    `open_phrase_appeared > profile_text_open_phrase > github_hireable`. No LLM, no I/O, no
    `Date.now()` — `now` is always a parameter.
  - Verify: `pnpm test -- tests/unit/shared/lib/availability-signals/score.test.ts` —
    `github_hireable` alone can never yield `open_signal_recent` at any age but does yield
    `open_signal_present`; `open_phrase_appeared` alone (one distinct type) yields
    `open_signal_present`, not `open_signal_recent`; an `open_phrase_appeared` 31 days old plus a
    fresh `profile_text_open_phrase` yields `open_signal_present`; empty input ⇒ `no_public_signal`
    with `scoreBps === 0` and `topSignalType === null`.

- [ ] **Precedence resolver, provenance labels, exact copy, and the DTO**
  - Files: `src/shared/lib/availability-signals/disclosure.ts` (new),
    `tests/unit/shared/lib/availability-signals/disclosure.test.ts` (new)
  - Do: `resolveAvailabilityDisclosure({ restricted, claim, verdict, signals })` implementing the
    spec's five rules in order, returning `AvailabilityDisclosureDTO | null`. Export
    `AVAILABILITY_DISCLOSURE_COPY` (the exact sentence from `spec.md` §Presentation),
    `AVAILABILITY_CHIP_COPY` per bucket, and `AVAILABILITY_SIGNAL_LABELS` — the four provenance
    sentences from `spec.md` §"Provenance labelling", verbatim. Every DTO signal row carries
    `provenance: 'self_declared_external' | 'self_declared_in_app' | 'inferred'` and, for
    `open_phrase_appeared`, `priorObservedAt`. The DTO type must **not** declare `scoreBps`,
    `distinctSignalTypes`, or `detectorVersion`.
  - Verify: `pnpm test -- tests/unit/shared/lib/availability-signals/disclosure.test.ts` —
    `restricted: true` returns exactly the same value as "no signals" (`toEqual(null)`);
    `openToStatus: ['nothing']` plus a strong verdict returns `null`; `openToStatus: ['hires']`
    returns `stated_by_subject` with no `bucket` key; every signal row has a `provenance` field; a
    type-level test (`@ts-expect-error` on `dto.scoreBps`) asserts the DTO has no numeric score
    field; `AVAILABILITY_SIGNAL_LABELS.github_hireable` contains `"Last seen"` and does not contain
    `"since"`.

## Phase 2 — Schema, grants, data classification

- [ ] **Add the three tables to the Drizzle schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/<next>_builder_availability_tables.sql` (new),
    `drizzle/meta/_journal.json`, `drizzle/meta/<next>_snapshot.json` (new),
    `drizzle/migration-hashes.json`
  - Do: add `builderAvailabilitySignals`, `builderAvailabilityScores`,
    `builderAvailabilityRefreshQueue` exactly as written in `spec.md` §"Data class and storage", in a
    new commented section naming this plan. The comment must state (a) why the queue has **no
    `organization_id`** (cross-tenant interest leak), (b) why the tables are `builder_`-prefixed
    (the unrelated `availability_rules`/`availability_policies`/`availability_overrides` from
    `drizzle/0069`–`0071`), and (c) that `observed_at` is BuilderHunt's observation clock, not the
    subject's. Run `pnpm db:generate`; if you rename the auto-generated tag, update the matching
    `_journal.json` entry to match (this repo's convention — see the `0043` progress note in
    [`abuse-and-usage-integrity`](../../phase-1/32-abuse-and-usage-integrity/tasks.md)). Then
    `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: the generated SQL contains exactly three `CREATE TABLE` statements, the three `CHECK`
    constraints named in the spec, and no unrelated diff; `pnpm exec drizzle-kit check` and
    `pnpm test:migration-integrity` pass; `pnpm db:migrate` applies it cleanly; `pnpm type-check`.

- [ ] **Hand-write the grants migration**
  - Files: `drizzle/<next>_builder_availability_grants.sql` (new), `drizzle/meta/_journal.json`,
    `drizzle/meta/<next>_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: mint it with `pnpm exec drizzle-kit generate --custom` (grants-only, so plain `db:generate`
    emits nothing), then mirror `drizzle/0044_abuse_usage_integrity_rls_grants.sql`'s structure and
    comment density. No RLS — none of the three has an owning-subject column, same posture as
    `abuse_signals` (0044 §6). Grants, exactly:
    ```sql
    REVOKE ALL ON TABLE builder_availability_signals, builder_availability_scores,
      builder_availability_refresh_queue FROM PUBLIC;

    -- Read-only for the request path. The app role must never be able to fabricate or edit an
    -- inference about a named person, so it gets no write verb on either of these two.
    GRANT SELECT ON TABLE builder_availability_signals  TO builderhunt_app;
    GRANT SELECT ON TABLE builder_availability_scores   TO builderhunt_app;
    -- The read path enqueues a refresh for an identity the caller's organization already tracks.
    GRANT SELECT, INSERT ON TABLE builder_availability_refresh_queue TO builderhunt_app;

    -- The only writer. DELETE is required on all three: the worker purges expired signals, drops
    -- score rows no live signal supports, and `cascadeBuilderProcessingRestriction` runs on
    -- workerDb (src/shared/lib/repositories/enrichment-worker.ts uses workerDb throughout) even
    -- though it is triggered from an app request.
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE builder_availability_signals        TO builderhunt_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE builder_availability_scores         TO builderhunt_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE builder_availability_refresh_queue  TO builderhunt_worker;

    -- Investigation only. No DELETE: the admin purge endpoint calls the repository, which uses
    -- workerDb, so nothing ever runs a DELETE under the platform role.
    GRANT SELECT ON TABLE builder_availability_signals TO builderhunt_platform;
    GRANT SELECT ON TABLE builder_availability_scores  TO builderhunt_platform;
    ```
    No grants for `builderhunt_auth`, `builderhunt_capability`, or `builderhunt_readonly`; no
    `TRUNCATE`, no `REFERENCES`. Finish with `node scripts/db/verify-migration-integrity.mjs --write`
    and commit all four files together.
  - Verify: `pnpm test:migration-integrity` passes and `pnpm db:migrate` applies it; then as
    `builderhunt_app`, `insert into builder_availability_scores …` raises `permission denied` and
    `insert into builder_availability_refresh_queue …` succeeds; as `builderhunt_worker` both
    succeed; as `builderhunt_platform`, `delete from builder_availability_signals` raises
    `permission denied`.

- [ ] **Register the data classes**
  - Files: `scripts/db/audit-schema.ts`, `docs/architecture/data-classification.md`
  - Do: add three `operational(...)` entries — `operational('builder_availability_signals',
    'builder_identity_id', ['availability-signals'])`,
    `operational('builder_availability_scores', 'builder_identity_id', ['availability-signals'])`,
    `operational('builder_availability_refresh_queue', 'builder_identity_id',
    ['availability-signals'])`. **Do not use the `global()` helper**: it records `publicDtoFields`
    and `retention: 'published history'`, and `docs/architecture/data-classification.md:3` defines
    `global-public` as "intentionally publishable" — the opposite of this feature's hard non-goal.
    In the doc table add three rows with public fields `none`, and annotate the scores row:
    *derived inference about an identified natural person; publication forbidden; read requires an
    entitlement; subject-suppressible*.
  - Verify: `pnpm db:audit-schema > /tmp/audit.json` — the JSON `findings` array must contain **no**
    entry mentioning `builder_availability_`, and its length must equal the pre-change length (53 at
    the time of writing; the script exits 1 because ~50 pre-existing tables are still unclassified,
    so "exit 0" is *not* the check — the check is that this plan adds no new finding).

- [ ] **Add the feature env vars**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: add, beside the other feature flags (`env.ts:103-129`):
    `AVAILABILITY_SIGNALS_ENABLED: z.enum(['true','false']).default('false')`,
    `AVAILABILITY_SIGNALS_IDENTITIES_PER_RUN` (50), `AVAILABILITY_SIGNALS_DAILY_FETCH_CAP` (500),
    `AVAILABILITY_SIGNALS_RETENTION_DAYS` (180), `AVAILABILITY_SIGNALS_HALF_LIFE_DAYS` (45),
    `AVAILABILITY_SIGNALS_RECENT_WINDOW_DAYS` (30), `AVAILABILITY_SIGNALS_REFRESH_DAYS` (7) — all
    `z.coerce.number().int().positive().default(...)`. All optional with safe defaults; disabled by
    default, matching `ENRICHMENT_ENABLED` (`env.ts:129`). Add no `superRefine` requirement — the
    feature degrades to a no-op rather than blocking boot. The `AVAILABILITY_SIGNALS_` prefix is
    mandatory: bare `AVAILABILITY_*` collides with the scheduling domain.
  - Verify: `pnpm test -- tests/unit/shared/lib/env.security.test.ts`; `pnpm type-check`; the app
    boots with none of them set and `AVAILABILITY_SIGNALS_ENABLED` resolves to `'false'`.

## Phase 3 — Collector, worker, admin endpoint, suppression enforcement

- [ ] **Repository for signals, scores, and the queue**
  - Files: `src/shared/lib/repositories/availability-signals.ts` (new),
    `tests/unit/shared/lib/repositories/availability-signals.test.ts` (new)
  - Do: same convention as `src/shared/lib/repositories/abuse-signals.ts` — every function takes an
    optional injectable `db` so tests can pass a disposable database. Default clients:
    `publicDb` (app role, `src/shared/lib/db/client.ts:52`) for `enqueueAvailabilityRefresh` and the
    read helpers; `workerDb` (`src/shared/lib/db/worker-db.ts`) for everything that writes signals or
    scores. Functions:
    `enqueueAvailabilityRefresh(builderIdentityId)` (`onConflictDoNothing`),
    `leaseAvailabilityQueue(limit, leaseSeconds)` (order by `availableAt asc`, skip live leases,
    `for update skip locked`), `rescheduleAvailabilityQueueRow(builderIdentityId, nextAvailableAt)`
    (sets `lastCheckedAt = now()`, clears the lease, resets `attempts`),
    `failAvailabilityQueueRow(builderIdentityId, errorCode, backoffSeconds)`,
    `upsertAvailabilitySignal(input)` (conflict target
    `(builderIdentityId, signalType, contentHash)`; `DO UPDATE SET observed_at = now(), expires_at =
    …` for `github_hireable`/`profile_text_open_phrase`, `DO NOTHING` for `open_phrase_appeared` —
    see `spec.md` §Worker),
    `deleteAvailabilitySignalsByType(builderIdentityId, types)`,
    `listLiveAvailabilitySignals(builderIdentityId)` (`expiresAt > now()`),
    `upsertAvailabilityScore(...)` / `deleteAvailabilityScore(builderIdentityId)`,
    `purgeExpiredAvailabilitySignals(limit)`, and
    `purgeAvailabilityForIdentity(builderIdentityId)` (signals + score + queue row, worker role).
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/availability-signals.test.ts` against a
    disposable database — a repeated upsert of identical `github_hireable` content leaves exactly
    one row with a **moved** `observed_at`; a repeated upsert of identical `open_phrase_appeared`
    content leaves one row with an **unmoved** `observed_at`; `purgeAvailabilityForIdentity` leaves
    zero rows in all three tables.

- [ ] **GitHub availability collector**
  - Files: `src/lib/availability-signals/collector.ts` (new),
    `tests/unit/lib/availability-signals/collector.test.ts` (new)
  - Do: `collectGithubAvailability(target: { username: string }, signal: AbortSignal)` calls
    `safeFetch('https://api.github.com/users/<encoded login>')` with
    `allowedHosts: getSourcePolicy('github').allowedHosts`
    (`src/lib/enrichment/policies.ts:38`), `userAgent: env.ENRICHMENT_USER_AGENT ??
    ENRICHMENT_DEFAULT_USER_AGENT`, `Accept: application/vnd.github.v3+json`, and the optional
    `env.GITHUB_TOKEN` bearer — i.e. lines 33–41 of `src/lib/enrichment/connectors/github.ts`
    verbatim, with `hireable: boolean | null` added to the response interface it declares at lines
    12–20 (which today omits it). Returns
    `{ kind: 'data'; hireable: boolean | null; bio: string | null; profileUrl: string }` or maps
    `SafeFetchError` to `{ kind: 'retry' | 'no_data' | 'stop' }` using that connector's exact
    mapping (lines 64–77): 404 ⇒ `no_data`, `rate_limited` ⇒ `retry` with `retryAt`,
    `timeout`/`upstream_error` ⇒ `retry`, `auth_required` ⇒ `stop`, anything else ⇒ `stop`,
    `SyntaxError` ⇒ `no_data`. Non-GitHub sources contribute **no fetch** — they use the stored
    `builder_identities.bio`, filtered by `isSubjectAuthoredBio`.
  - Verify: `pnpm test -- tests/unit/lib/availability-signals/collector.test.ts` with `safeFetch`
    stubbed — 404 ⇒ `no_data`; `rate_limited` ⇒ `retry` with a `retryAt`; a host outside
    `allowedHosts` never reaches the network.

- [ ] **The worker**
  - Files: `src/lib/availability-signals/worker.ts` (new),
    `tests/unit/lib/availability-signals/worker.test.ts` (new)
  - Do: `runAvailabilityWorker()`. Returns `{ disabled: true }` when
    `env.AVAILABILITY_SIGNALS_ENABLED !== 'true'`. Otherwise:
    1. `purgeExpiredAvailabilitySignals(...)`.
    2. Lease ≤ `env.AVAILABILITY_SIGNALS_IDENTITIES_PER_RUN` rows by `availableAt asc`.
    3. Per identity, its own transaction:
       (a) `select is_builder_processing_restricted($1)` — if restricted,
       `purgeAvailabilityForIdentity` (which also drops the queue row) and continue;
       (b) collect S1 (GitHub only, one fetch), S2 (`builder_identities.bio` + `detectOpenPhrase`),
       S3 (the two newest `builder_source_snapshots` rows for the identity via `detectPhraseAppeared`);
       (c) upsert present signals and **delete now-absent S2/S3 rows in the same transaction**;
       (d) `computeAvailabilityVerdict(liveSignals, now, { halfLifeDays:
       env.AVAILABILITY_SIGNALS_HALF_LIFE_DAYS, recentWindowDays:
       env.AVAILABILITY_SIGNALS_RECENT_WINDOW_DAYS })` → upsert the score row, or delete it when the
       bucket is `no_public_signal`;
       (e) `rescheduleAvailabilityQueueRow(id, now + AVAILABILITY_SIGNALS_REFRESH_DAYS)` — **never
       delete the row on success**; it is the "already checked" marker that stops the read path from
       re-enqueuing forever (`spec.md` §"Why the queue row is rescheduled and not deleted").
    4. Daily fetch cap: a Redis `availability:fetches:<YYYY-MM-DD>` counter with the in-memory
       fallback copied from `src/lib/discovery/worker.ts:65-95`; on cap return `capped: true` and
       leave the remaining rows queued.
    A per-identity error calls `failAvailabilityQueueRow` (bumps `attempts`, sets `lastErrorCode`
    and an exponential `availableAt`) and never aborts the run. Return
    `{ leased, signalsWritten, signalsDeleted, scoresWritten, scoresDeleted, restrictedSkipped,
    expired, fetches, capped, errors }`.
  - Verify: `pnpm test -- tests/unit/lib/availability-signals/worker.test.ts` — with the flag unset
    the worker returns `{ disabled: true }` and performs no fetch; running twice over the same
    identity produces identical row counts (idempotent) and leaves exactly one queue row with a
    future `availableAt`; a restricted identity ends with zero signal, score, **and** queue rows; a
    removed bio phrase deletes the S2 row and the score row.

- [ ] **Register the job and add the admin run-worker endpoint**
  - Files: `src/routes/api/admin/availability-signals/run-worker.ts` (new),
    `src/shared/lib/operational-schedules.ts`
  - Do: clone `src/routes/api/admin/alerts/run-worker.ts` in structure —
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, then
    `const { payload: result } = await withJobRun({ jobKey: 'availability.signals' }, async () => {
    const outcome = await runAvailabilityWorker(); return { processedCount: outcome.leased ?? 0,
    failedCount: outcome.errors?.length ?? 0, payload: outcome } })`, then
    `await auditPlatformAdminAction(principal, { action: 'admin.worker.run', targetType: 'worker',
    targetId: 'availability-signals', result: 'allowed' })` (note the two-argument signature —
    `principal` first), `return Response.json({ ok: true, ...result })`, with
    `platformAdminErrorResponse(err)` as the catch fallback. Add the matching
    `OPERATIONAL_SCHEDULES` entry: `{ jobKey: 'availability.signals', cronExpression: '15 4 * * *',
    timezone: 'Europe/Copenhagen', scope: 'platform', label: 'Availability signal refresh',
    sourceRoute: '/api/admin/availability-signals/run-worker' }` — without it `withJobRun` writes a
    `job_runs` row with a null `schedule_id` and the job never appears in the operations calendar.
    `withJobRun` and `OPERATIONAL_SCHEDULES` did not exist when this plan was drafted; every admin
    worker route at HEAD uses both.
  - Verify: `pnpm security:route-coverage` passes (the route is guarded, not allowlisted);
    `pnpm test -- tests/unit/shared/lib/operational-schedules.test.ts` (its
    `assertRegistryIsSafe()` case covers the whole live registry) passes;
    `curl -X POST -H 'Cookie: <admin session>' localhost:3000/api/admin/availability-signals/run-worker`
    returns `{"ok":true,"disabled":true}` with the flag unset, and an unauthenticated call returns
    401.

- [ ] **Extend the existing subject-restriction cascade**
  - Files: `src/lib/enrichment/worker.ts`
  - Do: in `cascadeBuilderProcessingRestriction` (line 206), after
    `purgeEnrichmentEvidenceForIdentity`, call `purgeAvailabilityForIdentity(builderIdentityId)` and
    widen the return type to include `availabilitySignalsPurged` / `availabilityScorePurged` /
    `availabilityQueuePurged`, adding them to the existing
    `log.info('enrichment_subject_restriction', …)` line. The function already runs on `workerDb`,
    which is why the Phase 2 grants give the worker `DELETE`.
  - Verify: `pnpm type-check`; `POST /api/me/builder/$builderId/restrict-processing` as a verified
    claimant returns the new counters, and `select count(*)` on all three availability tables for
    that identity is 0.

- [ ] **Document the collector in the source register**
  - Files: `docs/operations/public-enrichment-source-register.md`
  - Do: extend the existing `## github` section (line 9) rather than adding a competing entry: state
    that the availability collector reads `hireable` and `bio` from the same official
    `GET /users/{login}` endpoint the enrichment connector already calls, performs no HTML scraping
    and uses no third-party aggregator, retains signals for
    `AVAILABILITY_SIGNALS_RETENTION_DAYS`, is gated behind `AVAILABILITY_SIGNALS_ENABLED` rather
    than `ENRICHMENT_ENABLED`, and names the two subject controls. Also record that S2/S3 read only
    the stored bios of the eight allowlisted subject-authored sources.
  - Verify: the register lists every host the availability collector can reach and matches
    `getSourcePolicy('github').allowedHosts` (`['github.com','api.github.com']`).

## Phase 4 — Subject-facing surface first

- [ ] **Subject read endpoint**
  - Files: `src/routes/api/me/builder/$builderId/availability.ts` (new)
  - Do: `GET`. `requireTenantPrincipal` → `withTenantContext(principal, tx =>
    isVerifiedBuilderClaimant(tx, principal.userId, params.builderId))`, 403 otherwise — the exact
    gate at `src/routes/api/me/builder/$builderId/evidence-provenance.ts:22`. Read the global
    availability tables through `publicDb`, resolve with `resolveAvailabilityDisclosure`, and return
    the same DTO recruiters get plus
    `suppression: { setNotLooking: 'PATCH /api/me/builder/<id>', restrictProcessing: 'POST /api/me/builder/<id>/restrict-processing' }`.
    Returns `{ availability: null }` whenever `AVAILABILITY_SIGNALS_ENABLED !== 'true'`. No
    entitlement gate — a subject never pays to see what is said about them.
  - Verify: `pnpm security:route-coverage`; a non-claimant gets 403; a claimant gets an
    `availability` object deep-equal to the recruiter endpoint's for the same identity (asserted in
    the Phase 5 isolation check).

- [ ] **Subject card on `/me`**
  - Files: `src/routes/_dashboard/me/index.tsx`,
    `src/modules/builder-profile/components/AvailabilityDisclosureCard.tsx` (new)
  - Do: build `AvailabilityDisclosureCard` (shared by both surfaces) rendering the chip copy, the
    exact `AVAILABILITY_DISCLOSURE_COPY` sentence, and one row per signal using
    `AVAILABILITY_SIGNAL_LABELS[type]` — each row shows its provenance sentence, the source link,
    the ≤120-char excerpt, and for `open_phrase_appeared` **both** dates. Renders `null` when
    `availability` is `null`. On `/me`, render it under each claimed profile with the heading "What
    recruiters can see" and a one-click button that PATCHes `openToStatus: ['nothing']` via
    `PATCH /api/me/builder/$builderId` (`nothing` is an existing `OPEN_TO_OPTIONS` value at
    `src/routes/_dashboard/me/index.tsx:29-36` and an accepted enum member of that route's zod body).
  - Verify: `pnpm lint && pnpm type-check`; with `openToStatus: []` and a seeded signal the card
    shows the bucket chip; clicking the button re-fetches and the card disappears (precedence rule 3).

## Phase 5 — Recruiter surface, entitlement gate, forbidden-pattern tests

- [ ] **Recruiter read endpoint with the entitlement gate**
  - Files: `src/routes/api/builders/$builderId/availability.ts` (new)
  - Do: `GET`. `requireTenantPrincipal` → `withTenantContext(principal, tx =>
    findOrganizationBuilderByIdentity(tx, principal.organizationId, params.builderId))`, 404 if not
    tracked (same shape as `src/routes/api/builders/$builderId/synergy.ts:73-75`) →
    `getOrganizationEntitlement(tx, principal.organizationId)`; require
    `policy.paidActionsAllowed && ['pro','pro_max','team'].includes(policy.tier)` else
    `403 { error: 'plan' }`. Then `enqueueAvailabilityRefresh(identityId)` when the score row is
    missing or `computedAt` is older than `AVAILABILITY_SIGNALS_REFRESH_DAYS`, rate-limited via
    `rateLimit('availability-enqueue', getAuthedRateLimitId({ userId: principal.userId,
    organizationId: principal.organizationId }), 30, 60)`, and return
    `resolveAvailabilityDisclosure(...)`. Returns `{ availability: null }` whenever
    `AVAILABILITY_SIGNALS_ENABLED !== 'true'`.
    **Do not call `can(principal, 'resource:read')`**: at HEAD that predicate is
    `resource.creatorUserId === principal.userId || resource.visibility === 'organization'`
    (`src/shared/lib/authorization/permissions.ts:81-84`), so with no resource context it returns
    false for every caller, and `privateBuilderFields`
    (`src/shared/lib/repositories/organization-builders.ts:31-47`) does not select the two columns
    needed to supply that context. Membership plus tracked-by-this-organization is the gate every
    other `$builderId` route uses.
  - Verify: `pnpm security:route-coverage`; `curl` as a free-tier org ⇒ 403 `{"error":"plan"}`; as a
    pro org for an untracked identity ⇒ 404; as a pro org for a tracked identity with no signals ⇒
    `{"availability":null}`; `curl … | grep -Ei '"(scoreBps|score|percent|distinctSignalTypes|detectorVersion)"'`
    returns nothing.

- [ ] **Recruiter panel in the builder profile**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: fetch `/api/builders/${builderId}/availability` alongside the existing profile/notes/session
    fetches and render `AvailabilityDisclosureCard`. Keep the existing
    `builder.isClaimed && builder.openToStatus` block (line 285) as the `stated_by_subject` path —
    do not duplicate it, and do not render both. On a 403 with `error: 'plan'`, render the static
    unconditional "Availability signals — Pro" row that is byte-identical whether or not signals
    exist.
  - Verify: `pnpm lint && pnpm type-check`; in the browser a pro org sees the chip plus the
    expandable disclosure with a working source link; a free org sees the identical upsell row for a
    builder with signals and for one without.

- [ ] **Add the feature to the Pro plan copy**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: add `'Public availability signals'` to `PLAN_PRICING.pro.features` (line 88 onward). No
    `PLAN_LIMITS` entry — it is a boolean capability, like semantic search.
  - Verify: `pnpm test -- tests/unit/shared/lib/billing.test.ts`; `/pricing` lists it under Pro.

- [ ] **Test the forbidden surfaces**
  - Files: `tests/unit/shared/lib/availability-signals/forbidden-surfaces.test.ts` (new)
  - Do: assert by reading the real modules that no availability field can reach a forbidden surface:
    the CSV header and row builder in `src/routes/api/export/builders.ts`, the RSS item builder in
    `src/routes/api/feeds/$searchId.ts` (note: the route file is `$searchId.ts`, not `.xml`), the
    outreach draft body in `src/shared/lib/outreach.ts`, and every Resend template. Also assert that
    `'no_public_signal'` is not a reachable value of the exported DTO's `bucket` field and that the
    DTO type has no numeric field.
  - Verify: `pnpm test -- tests/unit/shared/lib/availability-signals/forbidden-surfaces.test.ts`
    passes; `grep -ril availability src/routes/api/export src/routes/api/feeds src/shared/lib/outreach.ts`
    returns nothing.

- [ ] **Route-level isolation and suppression checks against the real roles**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: add `checkAvailabilitySignals()` and register it in the runner list (lines 1225+, beside
    `checkEnrichmentAndEvidence()`): (1) org A cannot read availability for an identity only org B
    tracks (404, no existence leak); (2) a free-tier org gets 403 `plan`; (3) an identity with an
    active `builder_processing_restrictions` row returns a response byte-identical to a no-signal
    identity; (4) `builderhunt_app` cannot INSERT or UPDATE `builder_availability_signals` or
    `builder_availability_scores`; (5) `builder_availability_refresh_queue` has no
    `organization_id` column (`information_schema.columns`); (6) the subject and recruiter endpoints
    return deep-equal `availability` objects for the same identity.
  - Verify: `pnpm test:api-isolation:local` — all new checks pass, total check count increases.

- [ ] **Admin purge endpoint (the rollback lever)**
  - Files: `src/routes/api/admin/availability-signals/purge.ts` (new)
  - Do: `POST`, `requirePlatformAdminPrincipal` only — **no `tryCronPrincipal`**, this is
    destructive. Body `{ builderIdentityId?: string }`; with an id it calls
    `purgeAvailabilityForIdentity`, without one it deletes every row from
    `builder_availability_signals` and `builder_availability_scores` (both through the repository,
    i.e. `workerDb`, which is why `builderhunt_platform` needs no DELETE grant). Audit with
    `auditPlatformAdminAction(principal, { action: 'admin.availability.purge', targetType:
    'builder_identity', targetId: builderIdentityId ?? 'all', result: 'allowed' })`.
  - Verify: `pnpm security:route-coverage`; a purge returns the deleted counts and `select count(*)`
    on both tables is 0; a non-admin session returns 403.

- [ ] **Observability**
  - Files: `src/lib/availability-signals/worker.ts` (created in Phase 3)
  - Do: emit `log.info('availability_worker_run', { leased, signalsWritten, signalsDeleted,
    scoresWritten, scoresDeleted, restrictedSkipped, expired, fetches, capped, errors })` and
    `log.warn('availability_fetch_cap_reached', { fetches, cap })`. Never log a bio, an excerpt, a
    username, or a source URL — identity references are `builderIdentityId` only.
  - Verify: run the worker locally with the flag on and confirm the emitted line contains no
    personal text: `grep -E '"(bio|excerpt|username|sourceUrl)"'` over the run's log output returns
    nothing.

## Phase 6 — Optional AI explanation rung (droppable)

- [ ] **Register the `availability-explain` task**
  - Files: `src/shared/lib/ai/tasks.ts`
  - Do: declare `availabilityExplainTask: AITaskDefinition<…>` with `id: 'availability-explain'`
    (verified unregistered at HEAD), `tier: 'local-first'`;
    `inputSchema: z.object({ bucket: z.enum(['open_signal_present','open_signal_recent']), signals: z.array(z.object({ label: z.string(), source: z.string(), observedAt: z.string() })).min(1).max(4) })`
    — structured metadata only, no subject text, so no `wrapUntrusted` is needed;
    `outputSchema: z.object({ summary: z.string().min(1).max(280) })`;
    `cacheTtlSeconds: 604800`; `allowances: { free: 0, pro: 50, team: 200 }`;
    `maxOutputTokens: 300` (MiniMax M3's `<think>` block — see the `ping` note at `tasks.ts:80-85`).
    System prompt: one sentence, describe only the listed observations and their dates, never assert
    the person is looking for work, never mention or infer an employer, never add a fact not in the
    input. Add the entry to the `AI_TASKS` map at `tasks.ts:675`.
  - Verify: `pnpm test -- tests/unit/shared/lib/ai/tasks.test.ts` — the task is registered, its free
    allowance is 0, and a 281-character model output fails schema validation.

- [ ] **Wire the sentence into the disclosure card**
  - Files: `src/modules/builder-profile/components/AvailabilityDisclosureCard.tsx` (created in Phase 4)
  - Do: call `ai('availability-explain', …)` only when the card is expanded, render the sentence
    above the signal list prefixed "AI summary of the signals below:", and **hide it entirely** on
    any failure, disabled flag, or exhausted allowance. The structured signal list never depends on
    it.
  - Verify: with `AI_DISABLED=true` the card renders identically minus the sentence; with the task
    stubbed to throw, no error surfaces in the UI; `pnpm lint && pnpm type-check`.
