# Paste-a-JD Candidate Matching (tasks)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../phase-1/22-semantic-search/spec.md) (global `builder_embeddings` + pgvector HNSW query path — already shipped); [`ai-expansion`](../../phase-1/21-ai-expansion/spec.md) (task registry, budgets, zod validation, kill switches — already shipped); [`stripe-billing-platform`](../../phase-1/30-stripe-billing-platform/spec.md) (the Pro Max tier this feature is gated on does not bill anyone yet). Enhanced by [`match-evidence-panel`](../match-evidence-panel/spec.md) and [`availability-signals`](../availability-signals/spec.md) — dashed, never blocking; see spec.md "Optional enhancers".
> **Blocks**: nothing
> **Reality check (re-verified at HEAD 2026-07-27)**: Extends `src/shared/lib/db/schema.ts`, `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/cache.ts`, `src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/repositories/public-builder-embeddings.ts`, `src/routes/api/admin/legal/run-worker.ts`, `src/modules/dashboard/ui/shell/nav-config.ts`, `src/modules/search/components/SearchPage.tsx`, `src/routes/_landing/legal/privacy.tsx`, `scripts/db/audit-schema.ts`, `scripts/db/verify-api-isolation-local.mjs`. New: one tenant-private table, two AI tasks, one rate card, one `PermissionAction`, `src/lib/match/*`, `src/modules/match/*`, `/api/match/*`, `/_dashboard/match/*`. Zero new env vars, zero new workers.

Ordered so the app is shippable after every checkbox.

**Two conventions that apply to every task below.**
1. **Never hardcode a migration index.** Read the real next index from `drizzle/meta/_journal.json`
   at the moment you run the generator. `NNNN` below is a placeholder, not a number.
2. **Tests live under `tests/unit/**`, mirroring `src/`.** There are zero co-located tests in this
   repo and `vitest.config.ts` includes only `tests/unit/**/*.{test,spec}.{ts,tsx}`. A filter runs
   as `pnpm test -- <path under tests/>`.

## Phase 1 — Schema, RLS, classification

- [ ] **Add the `jd_match_runs` table**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `jdMatchRuns` exactly per spec.md §5 — `organizationId` (cascade to
    `organizations`), `creatorUserId` (`onDelete: 'restrict'`, per app-reality constraint 6),
    `title`, `jdFingerprint`, nullable `jdText`, `requirements`/`results` jsonb typed from
    `~/shared/lib/match-shared`, `artifactVersion` (`integer`, `notNull`, `default(1)` — required
    by security-policy rule 8, which admits JSONB only for *versioned* artifacts), `mode`,
    `poolSize`, `droppedEvidence`, nullable `reservationId`, `createdAt`, `expiresAt`.
    Constraints: `uniqueIndex('jd_match_runs_organization_id_id_unique')`, org+createdAt and
    org+fingerprint indexes, an `expires_at` index, a `mode` check constraint, and the composite
    tenant FK `(organization_id, reservation_id) → billing_credit_reservations(organization_id, id)`.
    The FK target exists — `billing_credit_reservations_organization_id_id_unique`
    (`schema.ts:1252`) — and `billingCreditAllocations` (`schema.ts:1277-1281`) is the working
    precedent for this exact shape. `reservationId` stays nullable: Postgres `MATCH SIMPLE`
    (the default) satisfies a composite FK whenever any column is NULL.
  - Verify: `pnpm type-check`.

- [ ] **Generate the table migration**
  - Files: `drizzle/NNNN_*.sql` (new), `drizzle/meta/_journal.json`, `drizzle/meta/NNNN_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: Run `pnpm db:generate` (`drizzle-kit generate` — writes the SQL, the journal entry and the
    snapshot together). Read the index it assigned from `drizzle/meta/_journal.json`; do not
    assume one. Confirm the emitted SQL contains only the `CREATE TABLE` plus
    indexes/constraints and no drop, rename, or rewrite of any existing table. Refresh the hash
    manifest with `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: `pnpm exec drizzle-kit check`; `pnpm test:migration-integrity` prints
    `{"valid":true,...}`; `pnpm db:migrate` on a fresh DB succeeds; `\d jd_match_runs` shows the
    unique index and the composite FK.

- [ ] **Mint the RLS + grants migration with `--custom`**
  - Files: `drizzle/NNNN_jd_match_runs_rls_grants.sql` (new), `drizzle/meta/_journal.json`, `drizzle/meta/NNNN_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: **Mint it with `pnpm exec drizzle-kit generate --custom --name=jd_match_runs_rls_grants`,
    never by hand.** A hand-created `.sql` has no journal entry and no snapshot, and
    `scripts/db/verify-migration-integrity.mjs` hard-fails on both (`assertSameFiles` compares the
    journal's `tag`s against `drizzle/*.sql` and its `idx`es against `meta/*_snapshot.json`); the
    generator writes all three. Then re-run `node scripts/db/verify-migration-integrity.mjs
    --write`. Same provenance as the repo's other grants-only migrations —
    `drizzle/0028_billing_rls_grants.sql`, `drizzle/0044_abuse_usage_integrity_rls_grants.sql`,
    `drizzle/0083_public_surface_indexing_grants.sql` — each of which has both a journal entry and
    a snapshot despite changing no Drizzle-visible schema.
    Content mirrors `drizzle/0044_abuse_usage_integrity_rls_grants.sql` — a header comment declaring
    the data class (tenant private, `organization_id`), then
    `ALTER TABLE jd_match_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE jd_match_runs FORCE ROW LEVEL SECURITY;`,
    then explicit `builderhunt_app` policies for SELECT/INSERT/UPDATE/DELETE each using
    `organization_id = nullif(current_setting('app.organization_id', true), '')`, plus a
    SELECT and a DELETE policy for `builderhunt_worker` on the same predicate (the retention
    sweep sets `app.organization_id` per batch via `withWorkerOrganization`, so it does not need
    a `USING (true)` policy). Grants — **and every write in this plan is checked against exactly
    these two lines**:
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE jd_match_runs TO builderhunt_app;`
    (covers `insertJdMatchRun`, `deleteJdMatchRun`, and the title rename) and
    `GRANT SELECT, DELETE ON TABLE jd_match_runs TO builderhunt_worker;` (covers
    `deleteExpiredJdMatchRuns` and nothing else). No grants for `builderhunt_auth`,
    `builderhunt_platform`, `builderhunt_capability`, `builderhunt_readonly`, or `PUBLIC`; no
    `TRUNCATE`, no `REFERENCES`.
  - Verify: `pnpm db:migrate`; `pnpm test:migration-integrity`; `pnpm test:rls:local` still
    passes; as `builderhunt_app` with no `app.organization_id` set,
    `select count(*) from jd_match_runs` returns 0 even with rows present.

- [ ] **Classify the table where the tooling actually reads it**
  - Files: `scripts/db/audit-schema.ts`, `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: Add `tenant('jd_match_runs', 'organization_id', ['jd-to-candidates-matching'], { retention: '90 days from creation, purged by the legal worker' })` to the `classifications`
    array in `scripts/db/audit-schema.ts`. **This is not optional bookkeeping**: the script scans
    `pgTable('…')` out of `schema.ts` and pushes `"<table>: unclassified table"` for anything it
    cannot find, then sets a non-zero exit code (`audit-schema.ts:104-106,140`). Then add the
    matching row to `docs/architecture/data-classification.md`'s table — class tenant-private,
    canonical owner `organization_id`, public fields none, retention "90 days; legal worker" —
    and add the `/api/match/*` routes to `docs/architecture/authorization-matrix.md` with their
    `can()` predicate and required tier (`match:delete` for DELETE; reads need no action).
  - Verify: `pnpm db:audit-schema` exits 0 and its `findings` array does not mention
    `jd_match_runs`; both docs mention `jd_match_runs`.

## Phase 2 — Pure libraries + tests

- [ ] **Add the shared zod contracts**
  - Files: `src/shared/lib/match-shared.ts` (new), `tests/unit/shared/lib/match-shared.test.ts` (new)
  - Do: Export `jdRequirementSchema`, `jdRequirementSetSchema`, `matchEvidenceSchema`,
    `rankedCandidateSchema`, `matchJdRerankOutputSchema` (with the duplicate-`candidateId`
    `superRefine`) and the `JdRequirementSet` / `JdMatchResult` types, exactly as spec.md §3/§5.
    Must stay pure and client-safe — `src/shared/lib/ai/tasks.ts` imports it and that module is
    imported from the browser, so no `node:crypto`, no DB, no env (the same constraint
    `src/shared/lib/sprints-shared.ts` already satisfies; copy its import discipline).
  - Verify: `pnpm type-check`; `pnpm test -- tests/unit/shared/lib/match-shared.test.ts` — a
    `ranked` array with two identical `candidateId`s is rejected by the `superRefine`; an `id`
    of `"r13"` passes the regex but `"rx"` does not; a 21-item `ranked` array is rejected.

- [ ] **Implement reciprocal rank fusion**
  - Files: `src/lib/match/rrf.ts` (new), `tests/unit/lib/match/rrf.test.ts` (new)
  - Do: `export const RRF_K = 60`;
    `fuseByReciprocalRank(rankings: Array<{ weight: number; ids: string[] }>): Array<{ id: string; rrfScore: number; bestRank: number; probeHits: number }>`
    — `rrfScore(d) = Σ_p weight_p / (RRF_K + rank_p(d))` with ranks starting at 1, output sorted
    by `rrfScore` desc then `bestRank` asc then `id` asc for a fully deterministic tie-break.
    Pure; no I/O.
  - Verify: `pnpm test -- tests/unit/lib/match/rrf.test.ts` — a doc ranked 1st by one weight-1.0
    probe beats a doc ranked 3rd by two; weight 0.5 halves a probe's contribution; a doc in every
    ranking wins on `probeHits`; identical inputs always produce identical order.

- [ ] **Implement citation verification**
  - Files: `src/lib/match/citations.ts` (new), `tests/unit/lib/match/citations.test.ts` (new)
  - Do: `normalizeForCitation(text)` (lowercase, collapse whitespace, strip `.,;:!?"'()[]`);
    `isCitationGrounded(citation, haystack)` — exact normalized substring, else ≥ 90 % of the
    citation's tokens of length ≥ 3 present; `verifyRerankOutput({ ranked, pool, requirementIds })`
    returning `{ results, droppedEvidence, unknownCandidateIds }` and applying spec.md §4 rules
    1–6: drop unverifiable evidence items, drop unknown `requirementId`s, drop unknown
    `candidateId`s, drop candidates left with zero evidence. Haystack is only that candidate's own
    `document` + a flattened string of its `profile` (`bio`, `topics`, `displayName`, `language`,
    `country` — the fields `buildEmbeddingDoc` itself uses; never `profileUrl` or `avatarUrl`,
    which would let a URL fragment launder a fabricated claim). Pure; no I/O.
  - Verify: `pnpm test -- tests/unit/lib/match/citations.test.ts` — a verbatim bio quote verifies;
    an invented quote is dropped; a quote taken from a *different* candidate is dropped; an
    unknown `candidateId` lands in `unknownCandidateIds`; a candidate with only invented evidence
    is removed and `droppedEvidence` counts every dropped item.

- [ ] **Implement JD normalization, fingerprinting, and probe assembly**
  - Files: `src/lib/match/jd-requirements.ts` (new), `tests/unit/lib/match/jd-requirements.test.ts` (new)
  - Do: `MATCH_JD_MIN_CHARS = 200`, `MATCH_JD_MAX_CHARS = 32000`, `MATCH_MAX_PROBES = 6`,
    `MATCH_POOL_SIZE = 50`, `MATCH_RESULT_SIZE = 20`;
    `normalizeJd(text)` (CRLF→LF, collapse ≥ 3 blank lines, trim);
    `truncateJd(text)` → `{ text, truncated }` cutting at the last paragraph boundary before the
    cap; `jdFingerprintOf(normalized)` (sha256 hex, `node:crypto` — server-only, which is why
    this lives here and not in `match-shared.ts`);
    `buildProbes(set: JdRequirementSet)` → `{ text, weight, requirementId | null }[]` where index
    0 is the role probe (weight 1.0, `requirementId: null`), then must-haves (1.0) before
    nice-to-haves (0.5), capped at `MATCH_MAX_PROBES` total. Probe text must be shaped like
    `buildEmbeddingDoc`'s output — `src/lib/semantic/embedding-doc.ts` emits, in order,
    `Name:` / `Source:` / `Bio:` / `Language:` / `Country:` / `Topics:` / `Followers:`, omitting
    empty fields; a probe uses the `Bio:` / `Language:` / `Topics:` subset with the same
    `"<Label>: <value>"` and `", "`-joined-topics formatting.
  - Verify: `pnpm test -- tests/unit/lib/match/jd-requirements.test.ts` — same JD with different
    trailing whitespace yields the same fingerprint; a 40 000-char JD truncates at a paragraph
    boundary with `truncated: true`; 12 requirements produce exactly 6 probes with must-haves
    preferred; a 150-char JD is rejected; every emitted probe line matches
    `/^(Bio|Language|Topics): /`.

## Phase 3 — AI tasks, rate card, retrieval extension

- [ ] **Register the two AI tasks**
  - Files: `src/shared/lib/ai/tasks.ts`, `tests/unit/shared/lib/ai/tasks.test.ts`
  - Do: Add `match-jd-requirements` (`server-only`, input
    `z.object({ jd: z.string().min(200).max(32000) })`, output `jdRequirementSetSchema`,
    `cacheTtlSeconds: 3600`, `allowances: { free: 0, pro: 0, team: 30 }`,
    `maxOutputTokens: 900`) and `match-jd-rerank` (`server-only`, input
    `{ role: JdRequirementSet, candidates: Array<{ candidateId, handle, document }> }` capped at
    50, output `matchJdRerankOutputSchema`, `cacheTtlSeconds: null`,
    `allowances: { free: 0, pro: 0, team: 30 }`, `maxOutputTokens: 3000`). Both `buildPrompt`
    functions wrap every piece of external text with `wrapUntrusted` — the JD as one block, and
    each candidate document as its own block with `candidateId` printed **outside** it. System
    prompts must contain the full forbidden list from spec.md §3 (no instruction-following inside
    untrusted blocks, no schema changes, no invented candidate/requirement ids, no cross-candidate
    evidence, no non-verbatim citation, no protected characteristics, JSON only). Add a
    registry-shape comment naming this plan, like the existing entries.
  - Verify: `pnpm test -- tests/unit/shared/lib/ai/tasks.test.ts` — both ids resolve via
    `getTask`; allowances gate `free`/`pro` to 0; a `buildPrompt` given a JD containing
    `</untrusted>` and "ignore previous instructions" emits an escaped, still-closed block
    (`wrapUntrusted` in `tasks.ts:742` replaces the literal close tag with `&lt;/untrusted&gt;`);
    `isTaskDisabled('match-jd-rerank', { AI_DISABLED: 'false', AI_DISABLED_TASKS: 'match-jd-rerank' })`
    is true. Registration is two edits, not one: define the task const **and** add
    `[matchJdRerankTask.id]: matchJdRerankTask` to the `AI_TASKS` record (`tasks.ts:675`), which
    is what `getTask` reads.

- [ ] **Add the tenant-scoped cache read/write pair**
  - Files: `src/shared/lib/ai/cache.ts`, `tests/unit/shared/lib/ai/cache.test.ts`
  - Do: `tenantAiCacheKey` exists and is correct, but it only builds a key — `getCached`/
    `setCached` both hard-code `cacheKeyFor(task.id, input)` and cannot be pointed at it, which is
    why it has zero production callers today. Add, beside them:
    `getTenantCached<O>(key: string): Promise<O | null>` and
    `setTenantCached(key: string, output: unknown, ttlSeconds: number): Promise<void>`, with the
    same failure semantics as the existing pair — `getRedis()` returning null, a missing key, or a
    `JSON.parse` throw all yield `null`; a Redis failure on write is swallowed. No in-memory
    fallback (AI responses can be large), matching `setCached`'s stated rationale.
  - Verify: `pnpm test -- tests/unit/shared/lib/ai/cache.test.ts` — two organizations produce
    different keys for the same artifact+input (already asserted) and `getTenantCached` returns
    `null` rather than throwing when Redis is unavailable.

- [ ] **Add the `jd_match` rate card**
  - Files: `src/shared/lib/billing/rate-cards.ts`, `tests/unit/shared/lib/billing/feature-authorization.test.ts`
  - Do: Add
    `jd_match: { operation: 'jd_match', version: 1, maxUnits: 12, maxDurationSeconds: 120, settlementGraceSeconds: 60, minimumTier: 'pro_max' }`
    to `RATE_CARDS` (3 cards today: `ai_sourcing_sprint`, `semantic_search_query`,
    `builder_work_sample_analysis` — `jd_match` is unclaimed). Do not change any existing card.
    `settlementGraceSeconds` is declarative only — `settleReservation`
    (`feature-authorization.ts:257-270`) passes a hard-coded `60` — so 60 is the only value that
    matches reality. `tierMeetsMinimum` ranks `pro_max` and `team` equally
    (`rate-cards.ts:26`), which is what admits real Team orgs. Extend the feature-authorization
    test to cover `checkEntitlement` for `jd_match`: no subscription → `no_subscription`; `pro` →
    `tier_too_low`; `pro_max` and `team` → allowed.
  - Verify: `pnpm test -- tests/unit/shared/lib/billing/feature-authorization.test.ts`.

- [x] **Fix the shared retrieval ordering so HNSW is actually used** — **DONE, shipped outside
      phase 2. Re-verified against HEAD on 2026-07-27 and still true.**
      `src/shared/lib/repositories/public-builder-embeddings.ts:101-114` exports
      `similarBuilderEmbeddingsQuery(db, queryVector, limit)`, which selects
      `source`/`sourceId`/`profile` plus ``similarity: sql`1 - (${distance})` `` and orders by
      `asc(distance)` where `distance = cosineDistance(builderEmbeddings.embedding, queryVector)`,
      with `where(isNotNull(builderEmbeddings.embedding))`.
      `findSimilarBuilderEmbeddings` (`:139-142`) is now a thin wrapper over it; its signature,
      selected columns and null filter are unchanged. This plan **reuses it unchanged.**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts` (already changed),
    `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` (already added). **No
    edit to make** — this entry exists so the next reader can re-confirm rather than re-do.
  - Verify (re-confirmation, 30 seconds):
    `grep -n "orderBy(asc(distance))" src/shared/lib/repositories/public-builder-embeddings.ts`
    returns a hit inside `similarBuilderEmbeddingsQuery`, and
    `pnpm test -- tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` is green.
    If either fails, this task is **not** done — untick it and escalate before continuing.
  - Evidence on file: the EXPLAIN-based regression test with a negative control lives at
    `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` — it opens a
    transaction, runs `set local enable_seqscan = off`, EXPLAINs the SQL the repository actually
    emits, asserts `Index Scan using builder_embeddings_hnsw_idx`, and separately asserts that
    ordering by the derived similarity expression *cannot* use the index (`:95`).
  - **Standing acceptance-criterion correction**, for anyone reusing this task: an indexable
    `ORDER BY` only makes the index *available* — the planner still costs it against a seq scan,
    and below ~2k embedded rows the seq scan legitimately wins (measured at `LIMIT 50`: 352 rows →
    seq scan at ~7 ms; 2k/5k/20k → HNSW index scan; the same figures are recorded in the
    repository's own docstring). Any "no `Sort` node" assertion must run under
    `set local enable_seqscan = off`, or seed past the crossover.
  - **Blocker trigger**: if `orderBy(asc(distance))` is ever reverted to a derived descending
    expression, stop — this plan's 300 ms stage-1 budget is void and the revert must be
    escalated, not worked around with a private fast copy.

- [ ] **Extend the embeddings repository for multi-probe retrieval and subject rights**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts`, `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`
  - Do: Add `findSimilarBuilderEmbeddingsForMatch(vectors: number[][], perProbeLimit: number)`
    returning, per probe, `{ source, sourceId, profile, document, similarity }[]` — one query per
    vector using the **same ordering the shipped query already uses** (`.orderBy(asc(distance))`,
    similarity as a select column), `where(isNotNull(builderEmbeddings.embedding))`, `publicDb`
    (this table has no `organizationId`). Factor the query builder out the same way
    `similarBuilderEmbeddingsQuery` is factored out, so the new shape is EXPLAIN-testable too. A
    separate function rather than a parameter on the existing one because this variant also
    selects `document`, which evidence grounding needs and semantic search does not.
  - Do: Add `findRestrictedIdentityPairs(pairs: Array<{ source: string; sourceId: string }>)`
    returning the restricted `(source, sourceId)` pairs. **It must NOT touch
    `builder_processing_restrictions`.** `drizzle/0017_enrichment_rls_policies.sql:57` revokes
    that table from `PUBLIC` and `:62` grants it only to `builderhunt_platform`; `:65-69` states
    outright that the app and worker roles never read it directly. A join would be
    `permission denied` the first time it ran as the real runtime role. Use the `SECURITY DEFINER`
    function that migration created for exactly this (`:70`, `GRANT EXECUTE … TO builderhunt_app,
    builderhunt_worker` at `:82`), as `repositories/enrichment.ts:187` already does:

    ```sql
    SELECT bi.source, bi.source_id
    FROM builder_identities bi
    WHERE (bi.source, bi.source_id) IN (…)
      AND is_builder_processing_restricted(bi.id)
    ```

    Grants used, both real: `SELECT ON TABLE builder_identities TO builderhunt_app`
    (`drizzle/0011_builder_claim_policies.sql:31`) and the `EXECUTE` above. Run it as a
    **post-filter** over the already-retrieved pool, never as a join inside the vector query, so
    the index path survives. A pool member with no `builder_identities` row is unrestricted.
  - Verify: `pnpm type-check`; `pnpm test -- tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`
    — 3 probe vectors return 3 result arrays, each carrying `document`; `EXPLAIN` on the emitted
    single-probe SQL under `set local enable_seqscan = off` shows
    `Index Scan using builder_embeddings_hnsw_idx`, mirroring the existing negative-control pattern
    in that file so the assertion is known to discriminate; and `findRestrictedIdentityPairs`
    returns the restricted pair when connected as `builderhunt_app` (this is the grant proof — it
    fails loudly under the old join design and passes under the function design).

## Phase 4 — Match service + repository

- [ ] **Add the tenant-scoped runs repository**
  - Files: `src/shared/lib/repositories/jd-match-runs.ts` (new)
  - Do: `insertJdMatchRun(tx, input)`, `findJdMatchRun(tx, organizationId, id)`,
    `listJdMatchRuns(tx, organizationId, limit)` (DTO allowlist: id, title, mode, poolSize,
    resultCount, createdAt — never `jdText`), `findRecentRunByFingerprint(tx, organizationId, fingerprint, sinceMs)`,
    `deleteJdMatchRun(tx, organizationId, id)`. Every function takes a `TenantTransaction`
    (`~/shared/lib/db/client`) and filters on `organizationId`; never import `publicDb`/`runtimeDb`
    or any other db value. Grant check: every write here is INSERT or DELETE under
    `builderhunt_app`, both covered by
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE jd_match_runs TO builderhunt_app` from the
    Phase 1 grants migration.
  - Verify: `pnpm type-check`; `pnpm security:boundaries` passes (it flags any non-allowlisted
    direct db import under `src/`); `grep -n "db/client" src/shared/lib/repositories/jd-match-runs.ts`
    shows only the `TenantTransaction` *type* import.

- [ ] **Add the worker-role retention repository**
  - Files: `src/shared/lib/repositories/jd-match-runs-worker.ts` (new)
  - Do: `deleteExpiredJdMatchRuns(transaction: WorkerTransaction, organizationId: string, now: Date): Promise<number>`
    — delete `jd_match_runs` rows for that organization whose `expires_at < now`, returning the
    count. **Separate file and separate transaction type from the tenant repository above**, for
    the same reason `alerts-worker.ts` is separate from the tenant alerts repository: the purge
    sweeps every organization and runs as `builderhunt_worker`, whose RLS policy is evaluated
    against `app.organization_id` set per batch by `withWorkerOrganization`
    (`repositories/alerts-worker.ts:14-26`). Running it on a `TenantTransaction` under
    `builderhunt_app` would see only the caller's own organization and delete nothing for anyone
    else — an RLS-silent no-op, the exact defect class app-reality constraint 7 records. Grant
    check: the only write is DELETE under `builderhunt_worker`, covered by
    `GRANT SELECT, DELETE ON TABLE jd_match_runs TO builderhunt_worker`. No INSERT/UPDATE grant
    exists for that role, so this file must never write.
  - Verify: `pnpm type-check`; the file imports `workerDb`/`WorkerTransaction` from
    `~/shared/lib/db/worker-db` and never `~/shared/lib/db/client`.

- [ ] **Implement the two-stage match service**
  - Files: `src/lib/match/match-service.ts` (new)
  - Do: `runJdMatch({ jd, principal, entitlement })`:
    (1) `normalizeJd` → guards → `truncateJd` → `jdFingerprintOf`;
    (2) extraction — `getTenantCached`/`setTenantCached` on
    `tenantAiCacheKey({ organizationId, artifact: 'match-jd-requirements', input: fingerprint })`
    (from `src/shared/lib/ai/cache.ts`, **not** `getCached`/`setCached`, which key on
    `ai:cache:{taskId}:{hash(input)}` with no organization component),
    `checkAndConsumeBudget(principal, entitlement, task)`, then `minimaxChat({ system: task.system,
    prompt: task.buildPrompt(input), schema: task.outputSchema, maxOutputTokens: task.maxOutputTokens })`
    — the same sequence `src/routes/api/ai/complete.ts:73-95` uses, and `minimaxChat` already does
    the one retry ai-policy rule 1 requires before throwing `AIParseError`;
    `confidence: 'low'` or `< 2` requirements → return `{ status: 'not_a_job_description' }`;
    (3) `buildProbes` → one `embedTexts(probeTexts)` call;
    (4) `findSimilarBuilderEmbeddingsForMatch(vectors, 60)`, drop below
    `SEMANTIC_SIMILARITY_THRESHOLD` (import from `~/lib/semantic/semantic-search`), drop
    `findRestrictedIdentityPairs` hits, apply stated language/country hard filters,
    `fuseByReciprocalRank`, truncate to `MATCH_POOL_SIZE`;
    (5) if pool `< SEMANTIC_MIN_LOCAL_MATCHES` (import, do not redefine) → `searchBuilders({ keywords: set.keywords })`,
    merge local-first deduped by `source:sourceId`, fire-and-forget `upsertEmbeddingStubs`
    (`~/lib/semantic/index-writer`), `mode = 'hybrid'`; if still `< 5` → `mode = 'deterministic'`,
    skip step 6;
    (6) ONE batched `match-jd-rerank` call with the pool trimmed to 600 chars of `document` per
    candidate — never one call per candidate;
    (7) `verifyRerankOutput` → backfill dropped candidates from the next RRF ranks with
    `verdict: 'possible'` and deterministic per-probe evidence → truncate to `MATCH_RESULT_SIZE`.
    Return `{ status: 'ok', mode, poolSize, droppedEvidence, truncated, requirements, results }`.
    Every provider/embedding failure resolves to a lower mode; nothing throws past the caller.
  - Do: **Two structural constraints on how this file is laid out.**
    (a) `pnpm security:provider-metering` (`scripts/check-provider-metering.mjs`, a hard step in
    `scripts/ci/local-quality.sh`) requires a `checkAndConsumeBudget(` or `reserveCredits(` call
    inside the *same top-level function*, by brace depth, as every `minimaxChat(` and
    `embedTexts(` call. `reserveCredits` happens in the route, not here, so each of the three
    provider call sites must live in a top-level function that itself calls
    `checkAndConsumeBudget`. Do not extract a bare `callProvider` helper.
    (b) `runJdMatch` takes an optional second argument, a `deps` bag defaulting to the real
    implementations — `{ runTask, embedTexts, retrieve, findRestricted, searchBuilders,
    upsertStubs }` — so the degradation ladder is unit-testable without a network. This is the
    injection shape `src/shared/lib/repositories/abuse-signals.ts:38` and
    `src/shared/lib/profile-removal.ts:224-228` already use; there is no E2E seam that returns a
    fabricated MiniMax *response* (`E2E_AI_TASK_SCENARIO` only covers
    `success | disabled | budget_exceeded | unsupported`, and it is global, not per-task).
  - Verify: `pnpm type-check`; `pnpm security:provider-metering` reports no findings; with
    `E2E_MODE=true E2E_EMBEDDINGS_SCENARIO=fallback` the service returns `mode: 'hybrid'` or
    `'deterministic'` and never throws (`fallback` is a real member of the enum in
    `tests/e2e/harness/env.ts:44` and makes `embedTexts` raise
    `AIEmbeddingUnavailableError`, `embeddings.ts:123`).

- [ ] **Unit-test the service's degradation ladder**
  - Files: `tests/unit/lib/match/match-service.test.ts` (new)
  - Do: Drive the ladder through the `deps` bag from the task above; use
    `E2E_EMBEDDINGS_SCENARIO=fallback` only for the embedding-outage case. Cover:
    warm index → `mode: 'ranked'` with 20 results; 6-row index → `hybrid`; 3-row index →
    `deterministic` and **zero** rerank calls; rerank returns an unknown `candidateId` → dropped,
    list backfilled to 20; rerank returns 100 items → `matchJdRerankOutputSchema` rejects;
    `isTaskDisabled` true for the rerank task → `deterministic`; extraction
    `confidence: 'low'` → `not_a_job_description`; embedding outage → `hybrid` when extraction
    already produced keywords, `503`-shaped failure otherwise.
  - Verify: `pnpm test -- tests/unit/lib/match/match-service.test.ts`.

## Phase 5 — API routes, billing gate, isolation proof

- [ ] **Add `POST /api/match/run`**
  - Files: `src/routes/api/match/run.ts` (new)
  - Do: `requireTenantPrincipal` → kill switch (`env.AI_DISABLED` / `isTaskDisabled` for both
    tasks → 503, **before** any reservation) → `!env.MINIMAX_API_KEY` → 503 → zod body
    `{ jd: z.string().min(200).max(32000), saveJobDescription: z.boolean().default(false) }` (400
    `jd_too_short` / `jd_too_long`) → `rateLimit('jd-match', `${principal.organizationId}:${principal.userId}`, 5, 300)`
    → `withTenantContext` for `getOrganizationEntitlement`; `!paidActionsAllowed` → 403
    `payment_blocked` → `checkEntitlement(tx, principal, { feature: 'jd_match' })`; not allowed →
    403 `{ error: 'entitlement', reason }` → `findRecentRunByFingerprint` within 1 h returns the
    existing run (no charge) → `reserveCredits(tx, principal, { reservationId: randomId(), operation: 'jd_match', idempotencyKey: `jd-match:${organizationId}:${fingerprint}:${hourBucket}` })`
    → `runJdMatch` → on `ok` persist via `insertJdMatchRun` (`jdText` only when
    `saveJobDescription`) and `settleReservation(tx, principal, { reservationId, actualUnits, idempotencyKey })`
    with `actualUnits` **10** for `ranked` / **3** for `hybrid`|`deterministic`; on
    `not_a_job_description` or any failure
    `releaseReservation(tx, principal, { reservationId, reason, idempotencyKey })` and return
    422/502. Both settle and release take a mandatory `idempotencyKey` — derive it from the
    reservation id (`${reservationId}:settle` / `:release`) so a retried request is a no-op.
    Never trust a client organization id; never return an ORM row.
  - Verify: `pnpm security:route-coverage` (the route uses `requireTenantPrincipal`, a recognized
    guard, so it needs no allowlist entry); `curl` as a seeded Pro Max org returns
    `{ runId, mode, results: [...] }` with ≤ 20 items; as a Pro org returns `403 tier_too_low`;
    the same JD twice within an hour creates one row (`SELECT count(*) FROM jd_match_runs`
    unchanged) and one settled reservation.

- [ ] **Add the `match:delete` permission action**
  - Files: `src/shared/lib/authorization/permissions.ts`, `tests/unit/shared/lib/authorization/permissions.test.ts`
  - Do: Add `'match:delete'` to the `PermissionAction` union and a `case 'match:delete': return
    resource.creatorUserId === principal.userId || elevated` arm to `can()`. **Reasoning
    re-verified at HEAD 2026-07-27 and still valid**: `permissions.ts:82-88` implements
    `resource:delete` as `creatorUserId === principal.userId || (visibility === 'organization' &&
    elevated)`, and `jd_match_runs` has **no `visibility` column** — so
    `resource.visibility` would be `undefined` and the `elevated` arm could never fire, making
    every run undeletable by anyone but its creator, even an owner, despite the run being paid for
    from pooled organization credits. **Reads need no new action**: every member of the
    organization may read any run (RLS plus the tenant repository already scope it), so `GET`
    routes do not call `can()`. `match:delete` is unclaimed at HEAD, as are the actions other
    phase-2 plans introduce (`integration:read`/`integration:manage` in
    [`ats-integrations`](../ats-integrations/spec.md), `pipeline:move`/`pipeline:configure` in
    [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md)) — no collision.
    security-policy "Review ownership" requires a dedicated security review for any
    authorization change; flag this task for one.
  - Verify: `pnpm test -- tests/unit/shared/lib/authorization/permissions.test.ts` — creator
    `member` may delete their own run; a non-creator `member` may not; `admin` and `owner` may
    delete any run in the organization. `pnpm type-check` — `can()` has no `default` arm, so a
    missing `case` is a compile error, which is the exhaustiveness proof.

- [ ] **Add the run read/delete routes**
  - Files: `src/routes/api/match/runs.ts` (new), `src/routes/api/match/$runId.ts` (new)
  - Do: `GET /api/match/runs` → `listJdMatchRuns` DTOs (no `jdText`). `GET /api/match/$runId` →
    `findJdMatchRun`; **404 when the run belongs to another organization**, never 403 (no
    existence leak); re-read display profiles for each `(source, sourceId)` from
    `builder_embeddings`, re-apply `findRestrictedIdentityPairs`, and render a
    `{ unavailable: true }` stub for rows that no longer exist. `DELETE /api/match/$runId` →
    `deleteJdMatchRun`, gated by `can(principal, 'match:delete', { creatorUserId: run.creatorUserId })`
    from the task above — **never** an inline `.role === 'owner'` comparison:
    `scripts/check-tenant-boundaries.mjs` matches `/\.role\s*(===|!==)\s*['"]/` across all of
    `src/` and fails on anything outside its small allowlist, which these routes are not on.
  - Verify: `pnpm security:boundaries`; `pnpm security:route-coverage`; `curl` a foreign run id →
    404 with no body detail; DELETE as a non-creator `member` → 403, as an `admin` → 204;
    `pnpm test -- tests/unit/shared/lib/authorization/permissions.test.ts`.

- [ ] **Prove tenant isolation against the real non-owner roles**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Add `checkJdMatchRuns()` alongside the existing `checkSprints()`
    (`verify-api-isolation-local.mjs:426`): seed a run in org A, then as org B assert
    `GET /api/match/$runId` → 404, `DELETE` → 404, `GET /api/match/runs` excludes it; assert a
    spoofed `organizationId` in body/query/header is ignored; assert `builderhunt_app` with no
    `app.organization_id` set selects zero rows; assert `builderhunt_worker` can `DELETE` an
    expired row **after** `set_config('app.organization_id', …, true)` and cannot `INSERT`
    (no grant); assert `builderhunt_auth`, `builderhunt_platform`, `builderhunt_capability` and
    `builderhunt_readonly` all get `permission denied` on `select * from jd_match_runs`. Also
    assert `findRestrictedIdentityPairs`' underlying statement succeeds as `builderhunt_app` —
    the one query in this plan whose grant is not on a table this plan owns. Register the new
    function in the `main()` call list (`:1225-1251`); it is order-independent, so place it
    beside `checkSprints()` rather than in the trailing must-run-last group.
  - Verify: `pnpm test:api-isolation:local` — all pre-existing checks plus the new ones pass, with
    `failed: 0` in the printed JSON.

## Phase 6 — `/match` UI

- [ ] **Add the composer route and page**
  - Files: `src/routes/_dashboard/match/index.tsx` (new), `src/modules/match/components/MatchPage.tsx` (new)
  - Do: Route mirrors `src/routes/_dashboard/sprints/index.tsx:21-28`'s `beforeLoad` shape —
    `getAppAuthSession()` then throw on a missing `userId`, plus `getIsAppAdmin()`. Page
    renders a `<textarea>` (min 200 / max 32 000 chars with a live counter), the
    external-AI-processing notice **above** the textarea, a "Save this job description with the
    run" checkbox (default off), a Run button, and the run history from `GET /api/match/runs`.
    Entitlement: fetch the run endpoint's 403 reason or a small entitlement probe and render the
    locked state — a Pro Max pill linking to `/pricing`, no textarea submit. Hide the whole
    surface when `useAICapabilities()` (`~/shared/lib/ai/useAICapabilities`) reports
    `disabled || !serverAI` — both fields exist on `UseAICapabilitiesResult` and are populated by
    an effect that fetches `/api/ai/config`, so `serverAI` is `false` on first paint; render a
    skeleton until the fetch settles rather than flashing the hidden state, matching the
    fail-closed-while-loading convention `SearchPage.tsx:701-705` documents for its semantic
    toggle. Never write the JD to `localStorage` and never put it in the URL.
  - Verify: Pasting 3 000 words and running shows a progress state then navigates to the run; a
    Pro-tier org sees the locked pill and cannot submit; `AI_DISABLED=true` hides `/match`
    entirely.

- [ ] **Add the run view and candidate card**
  - Files: `src/routes/_dashboard/match/$runId.tsx` (new), `src/modules/match/components/MatchRunView.tsx` (new), `src/modules/match/components/MatchCandidateCard.tsx` (new)
  - Do: Ranked list of ≤ 20 cards, each with avatar/handle/source link, a fit-score ring
    (reuse `ScoreRing` from `~/components/ui`), a verdict badge, matched/missing requirement
    chips, and 1–3 evidence rows rendering `claim` plus the quoted `citation` and a link to the
    profile source. Optional enhancer: when
    `src/modules/search/components/MatchEvidencePanel.tsx` exists (it is introduced by
    [`match-evidence-panel`](../match-evidence-panel/spec.md) and does **not** exist at HEAD),
    render it in a collapsed "why this score" disclosure below the JD evidence rows; when it does
    not, omit the disclosure and change nothing else — this plan never waits on that one.
    Track/untrack reuses `POST /api/builders/track` (`src/routes/api/builders/track.ts`) and
    `DELETE /api/builders/$builderId` (`src/routes/api/builders/$builderId.ts:140` — the route
    parameter is `$builderId`, not `$id`) exactly as `SearchPage.tsx` does. Honest banners: `hybrid` → "Not
    enough indexed matches yet — live search results are mixed in"; `deterministic` → "Ranked by
    similarity only — AI ranking was unavailable for this run"; `truncated` → "Only the first
    32 000 characters were analysed"; fewer than 20 results → show the real count, never pad.
    `unavailable: true` candidates render a "no longer indexed" stub.
  - Verify: A saved run renders identically on reload; every visible citation string appears
    verbatim in the linked profile's bio/topics; the `deterministic` banner appears when the
    rerank task is disabled.

- [ ] **Add navigation and the search cross-link**
  - Files: `src/modules/dashboard/ui/shell/nav-config.ts`, `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`, `src/modules/search/components/SearchPage.tsx`
  - Do: Navigation is **not** in `DashboardLayout.tsx` — that file only composes the rail, panel
    and topbar, and contains no `NAV` array and no `MOBILE_NAV_ITEMS`. It is data in
    `nav-config.ts`'s `NAV_AREAS`. Make **two** edits to the `discover` area: append
    `{ to: '/match', label: 'Match', icon: Target, group: 'Discover' }` to its `items` (importing
    `Target` from `lucide-react` alongside the existing icons), **and** add `'/match'` to its
    `routes` prefix list. Omitting the second makes clicking the item swap the rail out from under
    the user — the exact failure the file's own comment and `nav-config.test.ts` guard against.
    Extend that test with the new destination. In `SearchPage.tsx`'s `NoResults` block only
    (`SearchPage.tsx:1258`), add one line: "Hiring for a specific role? Paste the job description
    →" linking to `/match`. Change nothing else in `SearchPage`.
  - Verify: `pnpm test -- tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`; the item
    appears under Discover on desktop and in the mobile drawer (both render from `NAV_AREAS`);
    navigating to `/match` keeps the Discover rail icon lit; keyword search output is otherwise
    unchanged; `pnpm lint`.

## Phase 7 — Retention, disclosure, observability

- [ ] **Purge expired runs in the existing legal worker**
  - Files: `src/lib/match/retention.ts` (new), `src/routes/api/admin/legal/run-worker.ts`
  - Do: Add `purgeExpiredJdMatchRuns(): Promise<{ purged: number; errors: number }>` in
    `src/lib/match/retention.ts`, shaped like `legal.ts#processPendingDeletions`: iterate
    `listWorkerOrganizationIds()` and call
    `withWorkerOrganization(orgId, tx => deleteExpiredJdMatchRuns(tx, orgId, new Date()))` — both
    from `~/shared/lib/repositories/alerts-worker` — so each tenant batch gets its own transaction
    and its own `app.organization_id`, per security-policy's worker rule. **Do not put this in
    `src/shared/lib/legal.ts`**: that module is account-subject deletion under the auth/app roles,
    and this is a `builderhunt_worker` sweep; mixing them would drag `worker-db` into the legal
    module's import graph. Then in `run-worker.ts`, add it to the existing `Promise.all([...])`
    beside `processPendingDeletions()` / `processPendingOrganizationDeletions()` and widen the
    response to `Response.json({ ok: true, accounts, organizations, jdMatchRuns })` plus the
    `auditPlatformAdminAction` `details`. **No new endpoint and no new cron** — the daily legal
    cron already exists and `tryCronPrincipal` already authenticates it.
    Grant check: the only statement is a DELETE as `builderhunt_worker`, covered by
    `GRANT SELECT, DELETE ON TABLE jd_match_runs TO builderhunt_worker`; the organization scan uses
    `SELECT (id) ON TABLE organizations TO builderhunt_worker`
    (`drizzle/0010_worker_alert_policies.sql:25`), which `listWorkerOrganizationIds` already
    exercises today.
  - Verify: Insert a run with `expiresAt` in the past in org A and another in org B; authed
    `curl -X POST /api/admin/legal/run-worker` reports `jdMatchRuns: { purged: 2, errors: 0 }` —
    **both organizations**, which is what proves it is not running under the app role; a second
    call reports `purged: 0` (idempotent).

- [ ] **Disclose the retention half of external JD processing**
  - Files: `src/routes/_landing/legal/privacy.tsx`
  - Do: Less is needed than this plan originally assumed. `privacy.tsx:46` (§3 "Subprocessors")
    already names MiniMax M3 and already says the app sends *"your own submitted inputs (e.g. a
    job description)"*. What is missing is **retention**: extend that same `<li>` to state that
    job-description text is discarded after processing unless the user explicitly opts to save it
    with the run, in which case it is kept for at most 90 days, and that a non-reversible
    fingerprint (not the text) is what provides duplicate detection. Do **not** add a second
    subprocessor entry. Bump `CURRENT_CONSENT_VERSIONS` in `src/shared/lib/legal.ts` only if the
    project's versioning rule (`isMaterialVersionChange`, `legal.ts:50`) classifies a retention
    clause as material.
  - Verify: `/legal/privacy` renders the extended clause; `pnpm test -- tests/unit/shared/lib/legal.test.ts`.

- [ ] **Add match observability counters**
  - Files: `src/lib/match/match-service.ts`, `src/routes/api/match/run.ts`
  - Do: Emit structured `log.info`/`log.warn` (`src/shared/lib/log.ts`) with an allowlist only:
    `taskId`, `provider`, `mode`, `poolSize`, `resultCount`, `droppedEvidence`,
    `unknownCandidateIds.length`, `latencyMs`, `settledUnits`, redacted
    `organizationId`/`requestId`. Warn when `droppedEvidence / totalEvidence > 0.10` or when any
    unknown candidate id appears. **Never log the JD, a prompt, or a model response.** `log`'s
    own `redactLogValue` (`log.ts:27-29`) already scrubs keys matching `/prompt|response|bio|…/i`,
    but it is a key-name filter and would not catch a JD passed under a key like `jd` or `input` —
    treat it as a backstop, not the control. The control is the allowlist above.
  - Verify: A run logs one line with no JD substring present (`grep` the captured log for a
    distinctive phrase from the test JD → no match).

- [ ] **Quality gate before the rate card goes live**
  - Files: `plans/phase-2/jd-to-candidates-matching/plan.md` (record the outcome in the Risks table)
  - Do: Hand-label 20 real JDs against a warm index and compare the AI reranked top-20 against
    the pure RRF top-20 (precision@10 on the labels). If the reranker does not measurably beat
    the deterministic order, ship `mode: 'deterministic'` as the default and settle 3 credits
    instead of 10 rather than charging for no gain.
  - Verify: The comparison numbers are recorded in the Risks table of this plan's `plan.md`
    before Pro Max is enabled anywhere.

- [ ] **Full verification pass**
  - Files: none
  - Do: Run `pnpm ci:local` — it already chains, in order, `test:migration-integrity`,
    `drizzle-kit check`, `test:migrations:local`, `test:rls:local`, `test:api-isolation:local`,
    `security:boundaries`, `security:route-coverage`, `security:provider-metering`,
    `db:audit-schema` (soft), `lint`, `type-check`, `test`, `test:e2e` and `build`. Do not
    substitute a hand-rolled subset. Then exercise the degradation matrix end to end: warm index →
    `ranked`; empty index → `hybrid`; `AI_DISABLED_TASKS=match-jd-rerank` → `deterministic`;
    `AI_DISABLED=true` → `/match` hidden and `POST /api/match/run` → 503 with **zero**
    reservations created
    (`SELECT count(*) FROM billing_credit_reservations WHERE operation = 'jd_match'` unchanged);
    unentitled org → 403 with zero reservations.
  - Verify: `pnpm ci:local` reports every step green; the reservation-count invariant holds in
    every failure case.
