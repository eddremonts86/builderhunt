# Talent Market Intelligence Reports (tasks)

> **Status**: `pending`
> **Depends on**: [`proactive-discovery`](../../phase-1/23-proactive-discovery/spec.md) (the global index breadth every aggregate is computed from — already shipped); [`public-landing-pages`](../../phase-1/45-public-landing-pages/spec.md) (public page shell, SEO, and OG image plumbing — already shipped); [`content-marketing`](../../phase-1/46-content-marketing/spec.md) (the blog/content surface these reports extend — already shipped); [`claimable-profiles`](../../phase-1/36-claimable-profiles/spec.md) (`published_builder_profiles`, the consent basis for Phase 8 — already shipped). Enhanced by [`smart-alerts`](../../phase-1/34-smart-alerts/spec.md) (digest email delivery; not required).
> **Blocks**: nothing
> **Reality check**: Extends `src/lib/discovery/matrix.ts`, `src/shared/lib/db/schema.ts`, `src/shared/lib/seo/surfaces.ts`, `src/shared/lib/operational-schedules.ts`, `src/routes/sitemap[.]xml.ts`, `src/routes/robots[.]txt.ts`, `src/routes/api/og/explore.tsx` (clone target), `src/routes/api/admin/alerts/run-worker.ts` (clone target), `src/shared/lib/repositories/platform-content.ts`, `src/shared/lib/email.ts`, `src/routes/api/consent/index.ts`, `src/routes/_dashboard/me/index.tsx`, `scripts/db/verify-api-isolation-local.mjs`. Two new tables; additive columns only on existing ones.

Ordered so the app ships cleanly after every checkbox.

**Conventions for this file.** Unit tests live under `tests/unit/**` mirroring `src/` —
`vitest.config.ts` includes only `tests/unit/**/*.{test,spec}.{ts,tsx}`, and there are no
co-located tests under `src/`. Filter with `pnpm test -- <path under tests/>`. Never hardcode a
migration index: `drizzle/meta/_journal.json` holds 86 entries at the time of writing and moves
constantly — read it when you run the command.

## Phase 1 — Metric contract as pure, tested code

- [ ] **Export the topic frame from the discovery matrix**
  - Files: `src/lib/discovery/matrix.ts`, `tests/unit/lib/discovery/matrix.test.ts`
  - Do: Add `export const DISCOVERY_TOPIC_SLUGS: readonly string[]` (the `TOPICS[].slug` values in
    declaration order — 30 at HEAD, `matrix.ts:34-65`) and
    `export const DISCOVERY_TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>>` (slug →
    `TOPICS[].keywords`). Derive both from the existing private `TOPICS` array; do not retype it.
    Do not change `DISCOVERY_MATRIX`, `buildMatrix` or `cellAt` — the discovery worker's behaviour
    must be byte-identical.
  - Verify: `pnpm test -- tests/unit/lib/discovery/matrix.test.ts` — the four existing assertions
    still pass, plus new ones: `DISCOVERY_TOPIC_SLUGS` has 30 unique entries, every slug has a
    non-empty keyword array, and every `DISCOVERY_MATRIX` cell key starts with a member of
    `DISCOVERY_TOPIC_SLUGS` followed by `@`.

- [ ] **Define the report zod schemas**
  - Files: `src/shared/lib/market-reports/schema.ts` (new)
  - Do: Export `POPULATIONS`, `reportMetricsSchema` and `reportCoverageSchema` exactly per spec.md
    §3, plus `export type ReportMetrics` / `ReportCoverage`. Note `cohortReobservationRate` and
    `indexRowCreators` belong to **coverage**, not metrics (spec.md §2.1) — a reviewer who moves
    either into `reportMetricsSchema` has reintroduced the defect this plan exists to prevent.
    Pure module — no DB, no env, no I/O, importable from client and server.
  - Verify: `pnpm type-check`.

- [ ] **Implement the deterministic topic matcher**
  - Files: `src/shared/lib/market-reports/topics.ts` (new), `tests/unit/shared/lib/market-reports/topics.test.ts` (new)
  - Do: `matchesTopic(profile: { topics?: string[] | null; language?: string | null }, topicSlug: string): boolean`
    — case-insensitive exact match of any `DISCOVERY_TOPIC_KEYWORDS[topicSlug]` entry against an
    element of `profile.topics` or against `profile.language`. Never against the free-text
    `document` field (a bio saying "I don't write Rust" would match). No LLM, no regex over prose.
    Unknown slug returns `false` rather than throwing.
  - Verify: `pnpm test -- tests/unit/shared/lib/market-reports/topics.test.ts` —
    `{topics:['rust']}` matches `rust`; `{language:'Go'}` matches `go`; `{topics:['Rustacean']}`
    does **not** match `rust` (exact, not substring); unknown slug returns false.

- [ ] **Implement the metric math and the defensibility guards**
  - Files: `src/shared/lib/market-reports/metrics.ts` (new), `tests/unit/shared/lib/market-reports/metrics.test.ts` (new)
  - Do: Export `MIN_COHORT = 200`, `MIN_PERIODS = 2`;
    `compositionShare({ topicCount, indexedTotal })` → percent;
    `shareDelta({ current, prior, comparableFrame })` → `{ deltaPp: number | null, reason:
    'ok'|'coverage_changed'|'no_prior_period'|'insufficient_cohort' }` (always percentage points,
    never a relative percentage); `cohortReobservationRate({ cohortSize, reobservedInNextPeriod })`
    with a doc-comment stating in full that it measures how often BuilderHunt's own pipelines
    re-touched the cohort and is **not** builder activity (spec.md §2.1);
    `rankCoOccurrence(counts, topicCount, limit = 8)`; `matrixVersionHash(cellKeys)` (sha256 of the
    sorted joined keys); `assertNoForbiddenClaim(text)` throwing on
    `/developers?\s+(grew|increased|declined)/i`, `/\bmarket\s+(size|growth|demand)\b/i`,
    `/there are \d/i`, and `/[+-]?\d+(\.\d+)?\s*%\s*(growth|increase|more|fewer)/i`;
    `assertPopulationDeclared(metrics)` throwing when `population` is missing or not in
    `POPULATIONS`.
  - Verify: `pnpm test -- tests/unit/shared/lib/market-reports/metrics.test.ts` — asserts
    `comparableFrame: false` ⇒ `'coverage_changed'`, no prior ⇒ `'no_prior_period'`, cohort <
    `MIN_COHORT` ⇒ `'insufficient_cohort'`, the module exports **no** function taking two raw index
    counts and returning a growth ratio, `assertNoForbiddenClaim('Rust developers grew 18% this quarter')`
    throws while `'Rust holds 6.1% of indexed profiles'` does not, and
    `assertPopulationDeclared({ population: 'developers' } as never)` throws.

- [ ] **Pin the ingestion frame and make a sixth writer fail the build**
  - Files: `src/shared/lib/market-reports/metrics.ts`, `tests/unit/shared/lib/market-reports/index-writers.test.ts` (new)
  - Do: Export
    `export const INDEX_WRITE_CHOKEPOINT = 'src/shared/lib/repositories/public-builder-embeddings.ts'`
    and the exact five-entry `INDEX_ROW_CREATORS` list from spec.md §2.3
    (`src/lib/discovery/worker.ts`, `src/lib/semantic/semantic-search.ts`,
    `src/lib/sprints/semantic-write-through.ts`, `src/routes/api/builders/track.ts`,
    `src/routes/api/search/builders.ts`), each with a one-line human label used verbatim in the
    published methodology block. Add a doc-comment stating that this list *is* the sampling frame
    and that changing it changes what every published number means.
  - Do (test): the test reads the repository from disk and recomputes both sets — it fails when any
    file other than `INDEX_WRITE_CHOKEPOINT` contains `.insert(builderEmbeddings` or
    `.update(builderEmbeddings`, and when the set of files importing `upsertEmbeddingStubs` from
    `~/lib/semantic/index-writer` differs from `INDEX_ROW_CREATORS` (excluding
    `src/lib/semantic/index-writer.ts` itself and anything under `tests/` or `scripts/`).
    The failure message must say: "the sampling frame changed — update
    `INDEX_ROW_CREATORS` and the published methodology text in the same commit".
  - Verify: `pnpm test -- tests/unit/shared/lib/market-reports/index-writers.test.ts` passes at
    HEAD; adding a throwaway file that imports `upsertEmbeddingStubs` makes it fail.

- [ ] **Build the template narrative generator (the AI fallback, built first)**
  - Files: `src/shared/lib/market-reports/narrative-template.ts` (new), `tests/unit/shared/lib/market-reports/narrative-template.test.ts` (new)
  - Do: `buildTemplateNarrative(metrics: ReportMetrics, coverage: ReportCoverage, topicLabel: string)`
    → `{ headline, paragraphs, caveat }`, interpolating numbers from `metrics` into fixed sentences
    that always carry the "of BuilderHunt's indexed profiles" qualifier, and printing "baseline
    period — no comparison available" when `shareDeltaPp` is null. It must never mention
    `cohortReobservationRate` — that value belongs to the methodology block only. Ends by calling
    `assertNoForbiddenClaim` on its own concatenated output.
  - Verify: `pnpm test -- tests/unit/shared/lib/market-reports/narrative-template.test.ts` — null
    delta yields the baseline sentence; output passes its own claim guard; output contains no
    reference to re-observation or activity.

## Phase 2 — Tables, grants, classification

- [ ] **Add the two report tables and the two additive columns**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `marketReportSnapshots` and `marketReportListEntries` exactly per spec.md §3, with a
    section comment stating: global public, no `organization_id`, no RLS, same class as `changelog`;
    import `ReportMetrics`/`ReportCoverage` as types from `~/shared/lib/market-reports/schema`. Then
    add
    `publishedBuilderProfiles.includeInPublicRankings: boolean('include_in_public_rankings').notNull().default(false)`
    (to the table at line 228) and
    `userConsents.revokedAt: timestamp('revoked_at', { withTimezone: true })` (nullable, to the
    table at line 587) — expand-only, no existing column changed, no backfill (the defaults are
    correct for every row).
  - Verify: `pnpm type-check`.

- [ ] **Generate the schema migration**
  - Files: `drizzle/` (new migration from `pnpm db:generate`), `drizzle/meta/*`, `drizzle/migration-hashes.json`
  - Do: Run `pnpm db:generate`; review the emitted SQL for any unexpected drop/rename (there must
    be none — two `CREATE TABLE`s and two `ADD COLUMN`s only). Regenerate the hash manifest
    (`node scripts/db/verify-migration-integrity.mjs --write`) and commit `drizzle/meta/_journal.json`
    plus the new snapshot alongside the SQL. Take the index drizzle-kit assigns; do not rename it.
  - Verify: `pnpm db:migrate` on a fresh DB succeeds; `pnpm exec drizzle-kit check` and
    `pnpm test:migration-integrity` pass.

- [ ] **Mint the grants migration as a journaled custom migration**
  - Files: `drizzle/<next>_market_reports_grants.sql` (new — **must** be created with
    `pnpm exec drizzle-kit generate --custom`, matching the provenance of
    `drizzle/0025_public_tables_app_grants.sql` and `drizzle/0067_operational_schedule_grants.sql`),
    `drizzle/meta/*`, `drizzle/migration-hashes.json`
  - Do: Do **not** hand-create the `.sql` and do **not** guess the number.
    `scripts/db/verify-migration-integrity.mjs:9-15` hard-fails unless the `drizzle/*.sql` set
    exactly equals `_journal.json`'s tags with a matching `NNNN_snapshot.json` for each, and
    lines 33–35 fail unless `migration-hashes.json` is regenerated — and `drizzle-kit migrate` never
    applies an un-journaled file. Mint with `--custom`, read the index it produced from
    `drizzle/meta/_journal.json`, then fill in the body, mirroring `0025`'s reasoning comment:
    - `GRANT SELECT ON TABLE market_report_snapshots, market_report_list_entries TO builderhunt_app;`
    - `GRANT SELECT, INSERT, UPDATE ON TABLE market_report_snapshots, market_report_list_entries TO builderhunt_worker;`
    - `GRANT SELECT, UPDATE ON TABLE market_report_snapshots TO builderhunt_platform;`
      (Phase 4's publish/withdraw/supersede run on `platformDb`; they never touch list entries.)
    - `GRANT SELECT ON TABLE builder_embeddings TO builderhunt_worker;` — `drizzle/0025:19` granted
      that table to `builderhunt_app` only, so without this line the generation worker cannot read
      the index it aggregates.
    - `GRANT SELECT ON TABLE published_builder_profiles TO builderhunt_worker;` **and**
      `CREATE POLICY published_builder_profiles_worker_select ON published_builder_profiles FOR SELECT TO builderhunt_worker USING (true);`
      — `drizzle/0011:33` granted the app role only, and lines 3–4 put the table under
      `FORCE ROW LEVEL SECURITY` with app-only policies, so a grant without a policy silently
      returns zero rows to the Phase 8 generator. `USING (true)` matches the app role's own
      `published_builder_profiles_app_select` policy (`0011:17-18`): these rows are, by definition,
      profiles their subjects chose to publish.
    No `DELETE` to any runtime role (published rows are immutable). No RLS on the two new tables —
    document why in the comment (global public, no owning subject, same reasoning as
    `drizzle/0048`'s `status_checks` and `drizzle/0083`'s `public_surface_indexing`). Note in the
    comment that `builder_claims` is deliberately **not** granted to any additional role
    (spec.md §1.2). Then re-run `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: `pnpm db:migrate` and `pnpm test:migration-integrity` pass; then against the local DB:
    as `builderhunt_app`, `INSERT` into `market_report_snapshots` fails with `42501` while `SELECT`
    succeeds; as `builderhunt_worker`, `SELECT count(*) FROM builder_embeddings` and
    `SELECT count(*) FROM published_builder_profiles` both succeed and the latter returns the same
    count the owner role sees; as `builderhunt_worker`, `DELETE FROM market_report_snapshots` fails.

- [ ] **Record the data classification**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: Add both tables as **global public** with the publication policy (draft rows are not public;
    filtered by `status` in the public repository) and the per-role grant matrix from the migration
    above. Add `published_builder_profiles.include_in_public_rankings` and
    `user_consents.revoked_at` under their existing tables' rows, and record the new
    `published_builder_profiles_worker_select` policy in the authorization matrix.
  - Verify: `grep -c 'market_report' docs/architecture/data-classification.md` is non-zero and both
    tables and both new columns appear; no code change.

## Phase 3 — Aggregate computation + generation worker

- [ ] **Write the report repository (all SQL lives here)**
  - Files: `src/shared/lib/repositories/market-reports.ts` (new)
  - Do: Import `workerDb` from `~/shared/lib/db/worker-db` for aggregation **and** report writes,
    and `publicDb` from `~/shared/lib/db/client` for public reads. Deliberately **not** the app-role
    path that `src/lib/discovery/worker.ts` uses (it imports `publicDb`, which is `runtimeDb` — the
    app role): aggregation and draft insertion happen in one transaction, so running it as the app
    role would require granting the web-serving role `INSERT`/`UPDATE` on published report rows —
    exactly the privilege split `drizzle/0067` preserves between the worker and platform roles.
    Read-only `SELECT` for the worker on an already-public index is the smaller privilege, and the
    grants task above adds it.
    **Grant check for every write in this file**: the only writes are `INSERT` and `UPDATE` on
    `market_report_snapshots` / `market_report_list_entries` as `builderhunt_worker`, covered by the
    `GRANT SELECT, INSERT, UPDATE … TO builderhunt_worker` line minted above. Every other statement
    here is a `SELECT`.
    Functions: `countIndexedProfiles(periodEnd)`; `countTopicProfiles(topicSlug, periodEnd)` (SQL
    predicate built from `DISCOVERY_TOPIC_KEYWORDS` against `profile->'topics'` and
    `profile->>'language'`, mirroring `matchesTopic` exactly — a divergence between the SQL and the
    TS matcher is a silent metric error, so both read the same constant);
    `countCohortReobservation(periodStart, periodEnd)` (rows with `created_at` in the prior period
    whose `updated_at` falls in this one — doc-comment it as a coverage witness, spec.md §2.1);
    `countNewlyIndexed(periodStart, periodEnd)`; `coOccurrenceCounts(topicSlug, periodEnd)`;
    `insertReportDraft(row)` with `onConflictDoNothing` on `(slug, version)`;
    `findLatestPublished(slug)`; `listPublishedReports(limit)`; `findPublishedVersion(slug, version)`;
    `findPriorPeriodReport(topicSlug, periodStart)`. Every public read returns an explicit field
    allowlist — never `select()` of the whole row.
    **Guard note**: no function here may reference `builder_identities.discovered_by`. That column
    is introduced by [`collaboration-graph`](../collaboration-graph/spec.md) and does not exist at
    HEAD; every metric in this plan is keyed on `builder_embeddings` and needs none.
  - Verify: `pnpm type-check`; `grep -c discovered_by src/shared/lib/repositories/market-reports.ts`
    returns 0; a throwaway `tsx` script prints a non-zero `countIndexedProfiles(new Date())` against
    the local DB.

- [ ] **Compose the generation worker**
  - Files: `src/lib/market-reports/worker.ts` (new), `tests/unit/lib/market-reports/worker.test.ts` (new)
  - Do: `runMarketReportWorker({ periodEnd, force })`: derive `periodStart` (first day of the
    previous UTC month) and the coverage envelope — `matrixVersionHash(DISCOVERY_MATRIX.map(c => c.key))`,
    `env.DISCOVERY_DAILY_STUB_CAP` (`src/shared/lib/env.ts:114`), `newlyIndexed`,
    `discoveryAttributedPct`, `MIN_COHORT`, `cohortReobservationRate`, and
    `indexRowCreators: INDEX_ROW_CREATORS`. For each `DISCOVERY_TOPIC_SLUGS` entry, in **its own
    transaction**, compute metrics via Phase 1's pure functions, set `population: 'indexed_profiles'`,
    mark `suppressed` under `MIN_COHORT`, build the template narrative, run
    `assertPopulationDeclared` and `assertNoForbiddenClaim`, and insert a `status: 'draft'` row. A
    topic that throws is logged and skipped — never aborts the run. Return
    `{ periodStart, periodEnd, generated, skippedExisting, insufficientData, failed }`.
  - Verify: `pnpm test -- tests/unit/lib/market-reports/worker.test.ts` (pure parts against a
    stubbed repository) — a run with a stub returning cohort 150 yields `insufficientData: 1` and no
    number in the draft; running twice against a stub that reports the conflict yields
    `generated: 0, skippedExisting: n`; every produced coverage envelope has a non-empty
    `indexRowCreators`.

- [ ] **Register the two cron schedules**
  - Files: `src/shared/lib/operational-schedules.ts`, `tests/unit/shared/lib/operational-schedules.test.ts`
  - Do: Add two `OPERATIONAL_SCHEDULES` entries — `{ jobKey: 'market-reports.generate',
    cronExpression: '0 3 1 * *', timezone: 'Europe/Copenhagen', scope: 'platform', label: 'Market
    report generation', sourceRoute: '/api/admin/market-reports/run-worker' }` and
    `{ jobKey: 'market-reports.digest', cronExpression: '0 9 2 * *', timezone: 'Europe/Copenhagen',
    scope: 'platform', label: 'Market report digest', sourceRoute:
    '/api/admin/market-reports/send-digest' }`. Both keys are unclaimed at HEAD.
    `assertRegistryIsSafe` (`operational-schedules.ts:137`) enforces key uniqueness and an
    `/api/admin/` source route.
  - Verify: `pnpm test -- tests/unit/shared/lib/operational-schedules.test.ts` passes with the two
    added entries; `POST /api/admin/operations/sync-schedules` as an admin returns both new
    `job_key`s.

- [ ] **Add the run-worker endpoint**
  - Files: `src/routes/api/admin/market-reports/run-worker.ts` (new)
  - Do: Clone `src/routes/api/admin/alerts/run-worker.ts` verbatim in structure, including its
    `withJobRun` wrapper (that file's line 27): `tryCronPrincipal(request) ?? await
    requirePlatformAdminPrincipal(request)`, then
    `withJobRun({ jobKey: 'market-reports.generate' }, …)` returning
    `{ processedCount: outcome.generated, failedCount: outcome.failed, payload: outcome }`, then
    `auditPlatformAdminAction(principal, { action: 'admin.worker.run', targetType: 'worker',
    targetId: 'market-reports', result: 'allowed' })`, with `platformAdminErrorResponse(err)` as the
    fallback. Accept `?force=true` (drafts only — refuse with 409 if the target slug already has a
    published row) and `?periodEnd=YYYY-MM-DD` for backfilling one period.
    Grant check: `withJobRun` writes `job_runs` as `builderhunt_worker`, already granted by
    `drizzle/0067:23`; the worker's own writes are covered by the Phase 2 grants.
  - Verify: `curl -s -X POST -H "X-Cron-Secret: $CRON_SECRET" localhost:3000/api/admin/market-reports/run-worker`
    returns `generated > 0`; an immediate re-run returns `skippedExisting > 0, generated: 0`;
    unauthenticated returns 401/403; `SELECT state, job_key FROM job_runs WHERE job_key =
    'market-reports.generate'` shows one `succeeded` row per invocation.

- [ ] **Prove the worker works as the real non-owner role**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Cover **every table the worker touches, not just the new ones** — the `drizzle/0025` failure
    was a missing grant on a *pre-existing* table, so a guard limited to new tables would have missed
    it too. Assert: `builderhunt_worker` can `SELECT` `builder_embeddings` and
    `published_builder_profiles` (and that the latter returns the same row count the owner sees,
    which is what catches a grant-without-policy), and can insert/update
    `market_report_snapshots`/`market_report_list_entries`; `builderhunt_app` can `SELECT` the two
    report tables but not `INSERT` them; no runtime role can `DELETE` either. Add a standing check
    that enumerates every table name appearing in `src/shared/lib/repositories/market-reports.ts`
    and asserts a grant exists for the role that file's connection uses, so a future added table
    cannot slip through.
  - Verify: `pnpm test:api-isolation:local` — all checks pass and the reported check count is higher
    than before the change.

## Phase 4 — Admin review, publish, correct, withdraw

- [ ] **Add platform-admin report repository functions**
  - Files: `src/shared/lib/repositories/platform-content.ts`, `tests/unit/shared/lib/repositories/platform-content.test.ts`
  - Do: Add `listPlatformMarketReports()`, `findPlatformMarketReport(id)`,
    `publishPlatformMarketReport(id, userId)` (sets `status='published'`, `published_at`,
    `published_by_user_id`; only from `draft`), `withdrawPlatformMarketReport(id)`,
    `supersedePlatformMarketReport(id)` — all via the `platformDb` this file already imports from
    `../db/client` (line 2), following the file's existing style. No function may `UPDATE`
    `metrics`, `coverage`, `narrative` or `topic_slug` on any row.
    Grant check: these are `SELECT`/`UPDATE` as `builderhunt_platform`, covered by the
    `GRANT SELECT, UPDATE ON TABLE market_report_snapshots TO builderhunt_platform` line minted in
    Phase 2. There is deliberately no platform `INSERT` — drafts come only from the worker.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/platform-content.test.ts` — a publish
    call on an already-published row is a no-op; no exported function mutates a published row's
    numbers.

- [ ] **Add the admin report endpoints**
  - Files: `src/routes/api/admin/market-reports/index.ts` (new), `src/routes/api/admin/market-reports/$id/publish.ts` (new), `src/routes/api/admin/market-reports/$id/withdraw.ts` (new)
  - Do: Follow `src/routes/api/admin/changelog/index.ts` exactly (`requirePlatformAdminPrincipal`,
    zod body, `auditPlatformAdminAction`, `platformAdminErrorResponse`). Publish runs
    `assertNoForbiddenClaim(narrative)` **and** `assertPopulationDeclared(metrics)` and rejects with
    422 on failure — the last gate before a number becomes public. Withdraw requires a `reason`
    string, recorded in the audit entry.
  - Verify: An authed admin publish flips `status` to `published`; a draft whose narrative contains
    "developers grew" returns 422; a non-admin gets 403; a second publish of the same id is
    idempotent.

- [ ] **Add the correction path**
  - Files: `src/routes/api/admin/market-reports/$id/correct.ts` (new), `src/lib/market-reports/worker.ts`
  - Do: `POST …/correct` with `{ correctionNote: z.string().min(10) }` recomputes the same period for
    the same topic, inserts `version = max(version) + 1` with the note and `supersedesVersion`, and
    marks the prior published row `superseded`. The published row itself is never mutated except its
    `status`.
  - Verify: After a correction, `SELECT version, status FROM market_report_snapshots WHERE slug = '<slug>'
    ORDER BY version` shows `1/superseded` and `2/draft`; `/reports/<slug>?v=1` still resolves after
    v2 publishes.

- [ ] **Build the admin review page**
  - Files: `src/routes/_dashboard/admin/market-reports.tsx` (new)
  - Do: Follow `src/routes/_dashboard/admin/changelog.tsx`'s structure. Table of drafts and
    published reports; detail panel showing metrics, the full coverage envelope (including
    `indexRowCreators` and the re-observation rate under a "crawl coverage" heading, never under
    "activity"), the narrative and its `narrativeSource`; publish / withdraw / correct actions with
    a confirmation. Publish button disabled until the reviewer ticks "I read the numbers and the
    methodology block".
  - Verify: An admin can publish a draft end-to-end from the UI; a non-admin navigating to
    `/admin/market-reports` is redirected or 403s.

## Phase 5 — Public pages + SEO

- [ ] **Register `reports` as a governed SEO surface**
  - Files: `src/shared/lib/seo/surfaces.ts`, `drizzle/<next>_reports_surface_seed.sql` (new, minted with `pnpm exec drizzle-kit generate --custom`), `drizzle/meta/*`, `drizzle/migration-hashes.json`
  - Do: Add `'reports'` to `SEO_SURFACES` (`surfaces.ts:14`) and a `SEO_SURFACE_DEFINITIONS.reports`
    entry (`label: 'Market reports'`, `paths: ['/reports']`, `scope: 'The reports index, every
    report page, and every prior version.'`). Then mint a custom migration seeding
    `INSERT INTO public_surface_indexing (surface, noindex, nofollow) VALUES ('reports', true, true)
    ON CONFLICT (surface) DO NOTHING;`, mirroring `drizzle/0083:31-33` — hidden on arrival, exactly
    like blog/changelog/roadmap. No new grants: `drizzle/0083:18-19` already covers the table for
    `builderhunt_app` and `builderhunt_platform`, and this plan adds no new writer of it.
    Read the migration index from `drizzle/meta/_journal.json`; do not hardcode it.
  - Verify: `pnpm test:migration-integrity` passes; `/admin/content` lists a fourth surface;
    `curl -s localhost:3000/robots.txt` shows `/reports` disallowed while the surface is hidden.

- [ ] **Add the public report server functions**
  - Files: `src/shared/lib/reports-data.ts` (new)
  - Do: `createServerFn` loaders mirroring `src/shared/lib/blog-data.ts`: `getPublishedReports()`
    (index) and `getReportPage({ slug, version? })` returning `{ report, priorVersion, related }`
    with a DTO allowlist and `status='published'` (or the explicitly requested superseded/withdrawn
    version) enforced in the repository, never in the component. Zod-validate the slug with
    `/^[a-z0-9-]{1,160}$/`, the same pattern `blog-data.ts:4` uses.
  - Verify: `pnpm type-check`; a draft slug returns `null`; a slug failing the regex throws before
    any query runs.

- [ ] **Build the methodology block component**
  - Files: `src/modules/landing/components/ReportMethodology.tsx` (new), `tests/unit/modules/landing/components/ReportMethodology.test.tsx` (new)
  - Do: Render entirely from `coverage` + `metrics` (never from prose), in the order spec.md §2.4
    fixes: period; "BuilderHunt's own index — a convenience sample assembled by a crawler and by
    user searches, not a census"; the named ingestion paths from `coverage.indexRowCreators`; the
    full metric definitions from spec.md §2.2 **including each metric's "this is NOT" sentence**;
    cells covered, matrix version, daily cap, newly indexed, discovery-attributed share, and
    `cohortReobservationRate` under an explicit "crawl coverage" heading with the sentence "this is
    how often we re-touched these profiles, not how active their owners were"; the suppression
    threshold; and the literal sentence "These figures describe BuilderHunt's index. They are not a
    measurement of the global developer population." Not collapsible, not behind a `<details>`.
  - Verify: `pnpm test -- tests/unit/modules/landing/components/ReportMethodology.test.tsx` — the
    disclaimer sentence renders for any coverage shape, including one with an empty
    `cellsCoveredInPeriod` and a null `cohortReobservationRate`; the string "activity" never appears
    in the rendered output; every entry of `indexRowCreators` appears.

- [ ] **Build the public report routes**
  - Files: `src/routes/_landing/reports/index.tsx` (new), `src/routes/_landing/reports/$slug.tsx` (new)
  - Do: SSR loaders (not the `useEffect` fetch pattern at `src/routes/_landing/changelog/$slug.tsx:42`
    — that is invisible to crawlers). `$slug` renders headline share, delta in pp or the explicit
    "not comparable" note, co-occurrence list, narrative, `<ReportMethodology>`, a
    superseded/correction banner when applicable, and an `/explore` CTA. `head()` emits title,
    description, `og:image` → `/api/og/report?slug=…`, and the robots meta resolved from
    `getSurfaceDirectives().reports` exactly as the blog/changelog route heads do. **Do not emit a
    `rel="canonical"` link** — `src/routes/__root.tsx:62` already emits one for every route from the
    leaf `pathname` (lines 14–16), which is already query-free and therefore already correct for
    `?v=N`; a second tag would conflict. A withdrawn slug returns **200** with an explicit
    "withdrawn" body and forces `{ name: 'robots', content: 'noindex, follow' }`, as does any
    explicitly requested superseded version.
    Emit JSON-LD `@type: 'Dataset'` (`name`, `description`, `temporalCoverage` as an ISO interval of
    `periodStart/periodEnd`, `measurementTechnique` = the metric definitions, `variableMeasured`,
    `creator`) plus `BreadcrumbList` — deliberately not `Article`, because this is data.
  - Verify: with the `reports` surface flipped to indexable,
    `curl -s localhost:3000/reports/<slug> | grep -c "not a measurement of the global developer"`
    returns 1 (proving it is server-rendered);
    `curl -s 'localhost:3000/reports/<slug>?v=1' | grep -c 'rel="canonical"'` returns exactly 1 and
    its `href` contains no `?v=`; a withdrawn slug returns HTTP 200 and contains
    `content="noindex, follow"`.

- [ ] **Add the report OG image endpoint**
  - Files: `src/routes/api/og/report.tsx` (new)
  - Do: Clone `src/routes/api/og/explore.tsx` (1200×630 SVG → `@resvg/resvg-js` PNG, same
    `escapeXml`/`truncate` helpers, same fallback-to-SVG on rasterize failure, same
    `Cache-Control: public, max-age=3600, s-maxage=3600`, and the same dynamic-import discipline its
    header comment explains, so no DB chain reaches the client bundle). Render topic label, period,
    the share figure, and the qualifier "of BuilderHunt's indexed profiles" **inside the image** so a
    shared card cannot lose the caveat.
  - Verify: `curl -sI 'localhost:3000/api/og/report?slug=<slug>'` returns `content-type: image/png`;
    an unknown slug returns a placeholder image rather than a 500.

- [ ] **Add reports to the sitemap and footer**
  - Files: `src/routes/sitemap[.]xml.ts`, `src/routes/robots[.]txt.ts`, `src/shared/components/Footer.tsx`
  - Do: In the sitemap, gate the whole reports block on `!isHiddenFromSitemap(surfaces.reports)`
    alongside the existing `listed.blog/changelog/roadmap` flags (lines 90–109), then add
    `${SITE}/reports` (weekly, 0.8) plus one entry per published report slug
    (`lastmod = published_at`, monthly, 0.7) from a single indexed query wrapped in its own
    try/catch so a reports-query failure cannot take the sitemap down. Do not attempt to make the
    whole route fail-soft — `listAllPublicRadarSlugs()` (line 124) and
    `listPublishedPortfolioClaimIds()` (line 137) already 500 the route on a DB outage, and fixing
    that is a pre-existing improvement outside this plan. Add `/reports` to `robots[.]txt.ts`'s
    surface handling. Footer gains a `/reports` link beside `/blog`, with
    `data-testid="footer-reports"`.
  - Verify: with the surface indexable, `curl -s localhost:3000/sitemap.xml | grep -c '<loc>.*/reports/'`
    equals the published-report count; with the surface hidden it returns 0 and the blog/radar
    entries are unchanged; stubbing the reports query to throw still yields HTTP 200.

## Phase 6 — Insights-tier gated data API

- [ ] **Add the entitlement constant and pricing copy**
  - Files: `src/shared/lib/billing-shared.ts`, `tests/unit/routes/_landing/pricing.test.tsx`
  - Do: `export const MARKET_INSIGHTS_ACCESS: Record<OrganizationTier, boolean> = { free: false,
    pro: false, pro_max: true, team: true }` next to `SOURCING_SPRINT_LIMITS` (line 54), with the
    same doc-comment convention. **Key it on `OrganizationTier`, not `PlanTier`** — the comment at
    lines 39–53 records that `Record<PlanTier, …>` plus `resolveLegacyPlanTier` is precisely the
    shape that let `/pricing` and the enforcing route disagree about Pro Max. Call sites index it
    directly with `entitlement.tier`, the way `src/routes/api/sprints/index.ts:41` does. Add
    "Market intelligence data API" to `PLAN_PRICING.team.features`.
  - Verify: `pnpm test -- tests/unit/routes/_landing/pricing.test.tsx` still passes with the new
    bullet; `pnpm type-check` fails if a `pro_max` key is omitted from the record.

- [ ] **Add the gated data endpoints**
  - Files: `src/routes/api/reports/$slug/data.ts` (new), `src/routes/api/reports/series.ts` (new), `scripts/db/verify-api-isolation-local.mjs`
  - Do: `requireTenantPrincipal(request)` → `withTenantContext(principal, tx => getOrganizationEntitlement(tx, principal.organizationId))`
    → deny with `403 { error: 'plan', upgradeUrl: '/pricing' }` when
    `MARKET_INSIGHTS_ACCESS[entitlement.tier]` is false. `rateLimit('reports-data', principal.userId, 60, 60)`
    (signature: `src/shared/lib/rate-limit.ts:44`). `/data` returns the full `metrics` + `coverage`
    for one published report; `/series` returns every published period for `?topic=` (all
    `DISCOVERY_TOPIC_SLUGS`, not just the curated set) as JSON or `?format=csv`. Both are read-only
    — no writes, therefore no grant to check beyond the app role's `SELECT` on
    `market_report_snapshots` minted in Phase 2 — and no tenant data appears in any response.
    Then extend `scripts/db/verify-api-isolation-local.mjs` with tenant A/B checks: free-tier denied,
    team-tier allowed, and a client-supplied `organizationId` in the query string never changing the
    outcome.
  - Verify: a team-tier org gets 200 with a `coverage` object; a free or pro org gets 403 with
    `upgradeUrl`; unauthenticated gets 401; the 61st request in a minute gets 429;
    `pnpm test:api-isolation:local` passes with the added checks.

## Phase 7 — Monthly digest email

- [ ] **Add the digest consent document and revoke path**
  - Files: `src/routes/api/consent/index.ts`, `src/shared/lib/repositories/account-privacy.ts`, `tests/unit/shared/lib/repositories/account-privacy.test.ts`
  - Do: Add `market_digest` to the `ConsentBody` document enum (`src/routes/api/consent/index.ts:14`)
    and **not** to that file's local `CURRENT_VERSIONS` map (line 7), nor to `src/shared/lib/legal.ts`'s
    — it is optional marketing and must never appear in `needsAcceptance`. Add
    `revokeAccountConsent(userId, document)` setting `revoked_at = now()` on the latest matching row
    and `listActiveDigestConsents()` (rows where `document = 'market_digest' AND revoked_at IS NULL`).
    Support `DELETE` on the route to revoke.
    Grant check: `user_consents` is already granted to the account-subject path by
    `drizzle/0020_account_subject_grants.sql:14`; `revoked_at` is a new column on an already-granted
    table, and PostgreSQL table-level `UPDATE` grants cover new columns, so no new grant is needed.
    The digest sender reads the same rows through the same role.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/account-privacy.test.ts`; POST then
    DELETE leaves the user unsubscribed; `GET /api/consent` returns an unchanged `needsAcceptance`
    array for a user with no `market_digest` row.

- [ ] **Add the signed one-click unsubscribe endpoint**
  - Files: `src/routes/api/reports/digest/unsubscribe.ts` (new), `src/shared/lib/market-reports/unsubscribe-token.ts` (new), `tests/unit/shared/lib/market-reports/unsubscribe-token.test.ts` (new)
  - Do: Pure `signUnsubscribeToken(userId)` / `verifyUnsubscribeToken(token)` using HMAC-SHA256 over
    `market-digest:v1:<userId>` with `env.BETTER_AUTH_SECRET`, constant-time compare (mirror
    `secretsMatch` in `src/shared/lib/auth/cron.ts`). The route accepts `GET` and `POST` (RFC 8058
    one-click), needs no session, revokes the consent, and always returns a plain confirmation page.
  - Verify: `pnpm test -- tests/unit/shared/lib/market-reports/unsubscribe-token.test.ts`; a tampered
    token returns 400 and revokes nothing; a valid `POST` revokes and returns 200.

- [ ] **Add the digest email sender**
  - Files: `src/shared/lib/email.ts`
  - Do: `sendMarketDigestEmail(to, { reports, unsubscribeUrl })` copying `sendAlertDigestEmail`'s
    structure (`email.ts:249`): the `E2E_MODE` outbox short-circuit first (line 41), then Resend,
    then the dev-log fallback. Include `List-Unsubscribe: <url>` and
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click` in the `headers` object, the methodology
    sentence verbatim, and a visible unsubscribe link. Never include a named list.
  - Verify: with `E2E_MODE=true` the outbox captures the message and both headers; with
    `RESEND_API_KEY` unset it dev-logs instead of throwing.

- [ ] **Add the digest send endpoint**
  - Files: `src/routes/api/admin/market-reports/send-digest.ts` (new)
  - Do: Same auth and `withJobRun` pattern as the run-worker, with
    `jobKey: 'market-reports.digest'`. Selects reports published since the last send, refuses any
    report whose `digest_sent_at` is already set unless `?force=true`, iterates
    `listActiveDigestConsents()` with a per-recipient try/catch, sets `digest_sent_at` once, and
    audits the action with the recipient **count** only (never addresses). Returns
    `{ reports, recipients, sent, failed }`.
    Grant check: the `digest_sent_at` UPDATE runs as `builderhunt_worker`, covered by the Phase 2
    `GRANT SELECT, INSERT, UPDATE … TO builderhunt_worker`.
  - Verify: a second call returns `sent: 0`; a single failing recipient does not abort the run;
    `grep -c '@' ` over the run's log output finds no email address.

## Phase 8 — Named-list content type (ships disabled)

- [ ] **Add the feature flag**
  - Files: `src/shared/lib/env.ts`, `.env.example`, `tests/unit/shared/lib/env.security.test.ts`
  - Do: `MARKET_REPORT_NAMED_LISTS_ENABLED: z.enum(['true', 'false']).default('false')` and
    `MARKET_REPORT_NAMED_LIST_MIN_CANDIDATES: z.coerce.number().int().positive().default(25)`.
    **Never `z.coerce.boolean()`** — coercion is `Boolean(input)`, so `'false'` parses to `true` and
    an operator explicitly disabling the flag would *enable* the feature guarding the plan's biggest
    privacy risk. `z.enum(['true','false'])` is the pattern every real boolean flag in this file
    uses (`AI_DISABLED` at line 110, `ENRICHMENT_ENABLED` at 129, `STRIPE_BILLING_ENABLED` at 141,
    `SIGNUP_REQUIRE_VERIFIED_EMAIL` at 169). Compare with `=== 'true'` at call sites. The numeric var
    keeps `z.coerce.number()`, matching `DISCOVERY_CELLS_PER_RUN` (line 113) — numeric coercion is
    safe and rejects non-numeric input. Names and placeholders only in `.env.example`.
  - Verify: `pnpm test -- tests/unit/shared/lib/env.security.test.ts` with a case asserting that
    parsing `MARKET_REPORT_NAMED_LISTS_ENABLED='false'` yields the string `'false'` and that a
    value of `'yes'` fails validation rather than silently enabling the feature.

- [ ] **Add the subject opt-in control**
  - Files: `src/routes/api/me/builder/$builderId.ts`, `src/shared/lib/repositories/builder-claims.ts`, `src/routes/_dashboard/me/index.tsx`, `tests/unit/shared/lib/repositories/builder-claims.test.ts`
  - Do: Extend the `PATCH` body with `includeInPublicRankings: z.boolean().optional()` and
    `updateVerifiedBuilderProfile` (`builder-claims.ts:232`) to persist it under the same
    `builderClaims.status = 'verified'` ownership check it already performs. In the profile editor
    add a default-off checkbox with copy that states plainly: "Allow BuilderHunt to include my name
    in public ranked lists. Off by default; you can turn it off at any time and you will be removed
    from every list immediately."
    Grant check: this is an `UPDATE` on `published_builder_profiles` as `builderhunt_app` under the
    existing `published_builder_profiles_app_update` policy (`drizzle/0011:22-25`), which already
    scopes to `published_by_user_id = app.user_id`. No new grant.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/builder-claims.test.ts` — toggling
    persists for the owner; a user cannot set the flag on an identity they have not verified.

- [ ] **Add the eligibility query**
  - Files: `src/shared/lib/repositories/market-reports.ts`, `tests/unit/shared/lib/repositories/market-reports.test.ts` (new)
  - Do: `listNamedListCandidates(topicSlug, limit)` — select from `published_builder_profiles`
    where `include_in_public_rankings = true` and the profile's `topics` contain the topic, joined
    to `builder_identities` for `followers_count`, excluding anyone where
    `is_builder_processing_restricted(builder_identity_id)` is true, ordered by first-party signals
    only (`followers_count`, then `published_builder_profiles.updated_at`).
    **Do not join `builder_claims`.** It is under `FORCE ROW LEVEL SECURITY` with three policies,
    all `TO builderhunt_app` and all requiring `subject_user_id = current_setting('app.user_id')`
    (`drizzle/0011:1-16`), so the join returns zero rows for an anonymous render and for the worker
    alike — a privacy filter that silently matches nobody is indistinguishable from a broken one.
    The `published_builder_profiles` row is itself the proof of a verified claim (spec.md §1.2).
    Also add `listRenderableListEntries(reportId)` applying the **same** filter live at render time
    via `publicDb`.
    Grant check: generation reads `published_builder_profiles` as `builderhunt_worker`, which needs
    both the `SELECT` grant and the `published_builder_profiles_worker_select` policy minted in
    Phase 2; render reads it as `builderhunt_app` under the existing `USING (true)` policy;
    `is_builder_processing_restricted(text)` has `EXECUTE` for both roles (`drizzle/0017:82`).
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/market-reports.test.ts` against a
    disposable database — a restricted identity is absent from both functions; an opted-out identity
    is absent; and, as the positive control that catches a silently-empty filter, three eligible
    opted-in identities are all **present**.

- [ ] **Generate and render named lists behind the guard**
  - Files: `src/lib/market-reports/worker.ts`, `src/routes/_landing/reports/$slug.tsx`
  - Do: When `env.MARKET_REPORT_NAMED_LISTS_ENABLED === 'true'`, generate `kind: 'named_list'` drafts
    storing only `(reportId, builderIdentityId, rank, basis)`; refuse to generate — and the publish
    endpoint refuses to publish — when candidates < `env.MARKET_REPORT_NAMED_LIST_MIN_CANDIDATES`.
    The page renders from `listRenderableListEntries`, so a withdrawal takes effect on the next
    pageview with no regeneration, links each entry to `/builders/$builderId`
    (`src/routes/builders/$builderId.tsx`), and emits `ItemList` JSON-LD built from the filtered
    entries only. Ranks are renumbered densely after filtering.
  - Verify: with the flag off, no named-list draft is created and `/reports/<named-slug>` renders
    nothing (404). With the flag on and 5 candidates, generation reports `insufficientData`. With 30
    candidates, revoking one subject's opt-in removes them from the rendered page on the next
    request without touching `market_report_list_entries`, and the remaining 29 renumber 1–29.

- [ ] **Register the AI narrative task**
  - Files: `src/shared/lib/ai/tasks.ts`, `tests/unit/shared/lib/ai/tasks.test.ts`
  - Do: Add `market-report-narrative` (unclaimed at HEAD) as an `AITaskDefinition`: `tier:
    'server-only'`; input
    `z.object({ topicLabel: z.string(), direction: z.enum(['rose','flat','fell','unknown']), comparable: z.boolean(), coOccurringTopicLabels: z.array(z.string()).max(8) })`
    — **no figures**; output per spec.md §5 with a `.superRefine` rejecting any `/\d/` in any field;
    `cacheTtlSeconds: 2592000`; `allowances: { free: 0, pro: 0, team: 0 }`; `maxOutputTokens: 700`;
    a system prompt forbidding numbers, percentages, growth claims, and any statement about the
    world outside BuilderHunt's index. Register it in `AI_TASKS` (line 675) and extend the registry
    test.
  - Verify: `pnpm test -- tests/unit/shared/lib/ai/tasks.test.ts` — the output schema rejects
    `{ headline: 'Rust up 18%' }`; the registry entry's allowances are all zero, so
    `decideBudget` returns `{ allowed: false, reason: 'plan' }` (`src/shared/lib/ai/budget.ts:27`)
    for every tier.

- [ ] **Wire the narrative into the worker with the digit guard**
  - Files: `src/lib/market-reports/worker.ts`
  - Do: When `MINIMAX_API_KEY` is set, `AI_DISABLED !== 'true'` and the task is not listed in
    `AI_DISABLED_TASKS`, call `minimaxChat` with the registry definition (as
    `src/lib/semantic/semantic-search.ts` does), capped at `NARRATIVE_MAX_PER_RUN = 12` per run and
    cached via the AI cache. Run `assertNoForbiddenClaim` on the result; on any failure (parse,
    digits, forbidden claim, provider error) fall back to `buildTemplateNarrative` and set
    `narrativeSource: 'template'`.
  - Verify: with `AI_DISABLED=true` every draft has `narrative_source = 'template'`; with a stubbed
    provider returning a digit-bearing narrative, the draft still falls back to template.

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm lint && pnpm type-check && pnpm test && pnpm test:migration-integrity && pnpm test:api-isolation:local && pnpm build`.
    Manual end-to-end: run the worker for two consecutive periods → publish → flip the `reports`
    surface to indexable in `/admin/content` → `/reports/<slug>` server-renders the methodology
    sentence, the named ingestion paths and a pp delta; edit `DISCOVERY_MATRIX` and regenerate → the
    delta becomes "not comparable"; withdraw → the page returns 200 with `noindex, follow` and its
    sitemap entry disappears; subscribe, send the digest, one-click unsubscribe.
  - Verify: all green; every published page carries the disclaimer sentence and a non-empty
    `indexRowCreators`; no published page contains a relative percentage growth claim; the word
    "activity" appears nowhere in a rendered metric label.
