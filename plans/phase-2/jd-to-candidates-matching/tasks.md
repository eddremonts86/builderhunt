# Paste-a-JD Candidate Matching (tasks)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../semantic-search/spec.md) (global `builder_embeddings` + pgvector HNSW query path — already shipped); [`ai-expansion`](../../ai-expansion/spec.md) (task registry, budgets, zod validation, kill switches — already shipped); [`stripe-billing-platform`](../../stripe-billing-platform/spec.md) (the Pro Max tier this feature is gated on does not bill anyone yet). Enhanced by [`match-evidence-panel`](../match-evidence-panel/spec.md) (per-match evidence rendering) and [`availability-signals`](../availability-signals/spec.md) (ranking boost; neither is required).
> **Blocks**: nothing
> **Reality check**: Extends `src/shared/lib/db/schema.ts`, `src/shared/lib/ai/tasks.ts`, `src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/repositories/public-builder-embeddings.ts`, `src/routes/api/admin/legal/run-worker.ts`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `scripts/db/verify-api-isolation-local.mjs`. New: one tenant-private table, two AI tasks, one rate card, `src/lib/match/*`, `src/modules/match/*`, `/api/match/*`, `/_dashboard/match/*`. Zero new env vars, zero new workers.

Ordered so the app is shippable after every checkbox.

## Phase 1 — Schema, RLS, classification

- [ ] **Add the `jd_match_runs` table**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `jdMatchRuns` exactly per spec.md §5 — `organizationId` (cascade to
    `organizations`), `creatorUserId` (`onDelete: 'restrict'`, per app-reality constraint 6),
    `title`, `jdFingerprint`, nullable `jdText`, `requirements`/`results` jsonb typed from
    `~/shared/lib/match-shared`, `mode`, `poolSize`, `droppedEvidence`, nullable
    `reservationId`, `createdAt`, `expiresAt`. Constraints:
    `uniqueIndex('jd_match_runs_organization_id_id_unique')`, org+createdAt and
    org+fingerprint indexes, an `expires_at` index, a `mode` check constraint, and the composite
    tenant FK `(organization_id, reservation_id) → billing_credit_reservations(organization_id, id)`.
  - Verify: `pnpm type-check`.

- [ ] **Generate the table migration**
  - Files: `drizzle/NNNN_*.sql` (new), `drizzle/meta/_journal.json`, `drizzle/meta/NNNN_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: Run `pnpm db:generate` (which writes the SQL, the journal entry and the snapshot
    together). Confirm the emitted SQL contains only the `CREATE TABLE` plus indexes/constraints
    and no drop, rename, or rewrite of any existing table. Refresh the hash manifest with
    `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: `pnpm exec drizzle-kit check` passes; `node scripts/db/verify-migration-integrity.mjs`
    prints `{"valid":true,...}`; `pnpm db:migrate` on a fresh DB succeeds; `\d jd_match_runs`
    shows both unique indexes and the composite FK.

- [ ] **Hand-write the RLS + grants migration**
  - Files: `drizzle/NNNN_jd_match_runs_rls_grants.sql` (new), `drizzle/meta/_journal.json`, `drizzle/meta/NNNN_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: **A hand-written `.sql` alone is never applied and hard-fails integrity** — add the
    matching `_journal.json` entry (same `tag`/`idx`) and a `NNNN_snapshot.json` (copy the
    previous snapshot, bump its `id`/`prevId`, since RLS/grants change no Drizzle-visible schema),
    then re-run `node scripts/db/verify-migration-integrity.mjs --write`;
    `scripts/db/verify-migration-integrity.mjs:12-15,27-30` asserts journal, SQL files and
    snapshots agree exactly. Same pattern as `plans/abuse-and-usage-integrity/tasks.md:45`.
    Content mirrors `drizzle/0044_abuse_usage_integrity_rls_grants.sql` — a header comment declaring
    the data class (tenant private, `organization_id`), then
    `ALTER TABLE jd_match_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE jd_match_runs FORCE ROW LEVEL SECURITY;`,
    then explicit `builderhunt_app` policies for SELECT/INSERT/UPDATE/DELETE each using
    `organization_id = nullif(current_setting('app.organization_id', true), '')`, plus the same
    four for `builderhunt_worker` (retention purge only). `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE jd_match_runs TO builderhunt_app;`
    and `GRANT SELECT, DELETE ON TABLE jd_match_runs TO builderhunt_worker;`. No grants for
    `builderhunt_auth`, `builderhunt_platform`, or `PUBLIC`; no `TRUNCATE`, no `REFERENCES`.
  - Verify: `pnpm db:migrate`; `pnpm test:rls:local` passes; direct SQL as `builderhunt_app`
    without `app.organization_id` set returns zero rows.

- [ ] **Register the table in the architecture docs**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: Add a `jd_match_runs` row: class tenant-private, owner key `organization_id`, DTO
    fields (id/title/mode/poolSize/createdAt/results — never `jdText` to anyone but the
    organization), retention "90 days, purged by the legal worker". Add the `/api/match/*`
    routes to the authorization matrix with their `can()` predicate and required tier.
  - Verify: Both tables mention `jd_match_runs`; no code change.

## Phase 2 — Pure libraries + tests

- [ ] **Add the shared zod contracts**
  - Files: `src/shared/lib/match-shared.ts` (new)
  - Do: Export `jdRequirementSchema`, `jdRequirementSetSchema`, `matchEvidenceSchema`,
    `rankedCandidateSchema`, `matchJdRerankOutputSchema` (with the duplicate-`candidateId`
    `superRefine`) and the `JdRequirementSet` / `JdMatchResult` types, exactly as spec.md §3/§5.
    Must stay pure and client-safe — `src/shared/lib/ai/tasks.ts` imports it from the browser, so
    no `node:crypto`, no DB, no env (same constraint `sprints-shared.ts` already satisfies).
  - Verify: `pnpm type-check`.

- [ ] **Implement reciprocal rank fusion**
  - Files: `src/lib/match/rrf.ts` (new)
  - Do: `export const RRF_K = 60`;
    `fuseByReciprocalRank(rankings: Array<{ weight: number; ids: string[] }>): Array<{ id: string; rrfScore: number; bestRank: number; probeHits: number }>`
    — `rrfScore(d) = Σ_p weight_p / (RRF_K + rank_p(d))` with ranks starting at 1, output sorted
    by `rrfScore` desc then `bestRank` asc for a deterministic tie-break. Pure; no I/O.
  - Verify: `pnpm test rrf` — a doc ranked 1st by one weight-1.0 probe beats a doc ranked 3rd by
    two; weight 0.5 halves a probe's contribution; a doc in every ranking wins on `probeHits`;
    identical inputs always produce identical order.

- [ ] **Implement citation verification**
  - Files: `src/lib/match/citations.ts` (new)
  - Do: `normalizeForCitation(text)` (lowercase, collapse whitespace, strip `.,;:!?"'()[]`);
    `isCitationGrounded(citation, haystack)` — exact normalized substring, else ≥ 90 % of the
    citation's tokens of length ≥ 3 present; `verifyRerankOutput({ ranked, pool, requirementIds })`
    returning `{ results, droppedEvidence, unknownCandidateIds }` and applying spec.md §4 rules
    1–6: drop unverifiable evidence items, drop unknown `requirementId`s, drop unknown
    `candidateId`s, drop candidates left with zero evidence. Haystack is only that candidate's own
    `document` + `profile` fields. Pure; no I/O.
  - Verify: `pnpm test citations` — a verbatim bio quote verifies; an invented quote is dropped; a
    quote taken from a *different* candidate is dropped; an unknown `candidateId` lands in
    `unknownCandidateIds`; a candidate with only invented evidence is removed and
    `droppedEvidence` counts every dropped item.

- [ ] **Implement JD normalization, fingerprinting, and probe assembly**
  - Files: `src/lib/match/jd-requirements.ts` (new)
  - Do: `MATCH_JD_MIN_CHARS = 200`, `MATCH_JD_MAX_CHARS = 32000`, `MATCH_MAX_PROBES = 6`,
    `MATCH_POOL_SIZE = 50`, `MATCH_RESULT_SIZE = 20`;
    `normalizeJd(text)` (CRLF→LF, collapse ≥ 3 blank lines, trim);
    `truncateJd(text)` → `{ text, truncated }` cutting at the last paragraph boundary before the
    cap; `jdFingerprintOf(normalized)` (sha256 hex, `node:crypto` — server-only, which is why
    this lives here and not in `match-shared.ts`);
    `buildProbes(set: JdRequirementSet)` → `{ text, weight, requirementId | null }[]` where index
    0 is the role probe (weight 1.0, `requirementId: null`), then must-haves (1.0) before
    nice-to-haves (0.5), capped at `MATCH_MAX_PROBES` total. Assert probe text is shaped like
    `buildEmbeddingDoc`'s output (`Bio:` / `Language:` / `Topics:` lines).
  - Verify: `pnpm test jd-requirements` — same JD with different trailing whitespace yields the
    same fingerprint; a 40 000-char JD truncates at a paragraph boundary with `truncated: true`;
    12 requirements produce exactly 6 probes with must-haves preferred; a 150-char JD is rejected.

## Phase 3 — AI tasks, rate card, retrieval extension

- [ ] **Register the two AI tasks**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
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
  - Verify: `pnpm test tasks.test` — both ids resolve via `getTask`; allowances gate `free`/`pro`
    to 0; a `buildPrompt` given a JD containing `</untrusted>` and "ignore previous instructions"
    emits an escaped, still-closed block; `isTaskDisabled('match-jd-rerank', { AI_DISABLED: 'false', AI_DISABLED_TASKS: 'match-jd-rerank' })` is true.

- [ ] **Add the `jd_match` rate card**
  - Files: `src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/billing/feature-authorization.test.ts`
  - Do: Add
    `jd_match: { operation: 'jd_match', version: 1, maxUnits: 12, maxDurationSeconds: 120, settlementGraceSeconds: 60, minimumTier: 'pro_max' }`.
    Do not change any existing card. Extend the feature-authorization test to cover
    `checkEntitlement` for `jd_match`: no subscription → `no_subscription`; `pro` → `tier_too_low`;
    `pro_max` and `team` → allowed.
  - Verify: `pnpm test feature-authorization`.

- [x] **Fix the shared retrieval ordering so HNSW is actually used** — **DONE, shipped outside
      fase 2.** `findSimilarBuilderEmbeddings` orders by the bare operator ascending with
      `1 - (embedding <=> $vec) AS similarity` as a select column only; signature, selected
      columns and `WHERE embedding IS NOT NULL` are unchanged. The query builder is exported as
      `similarBuilderEmbeddingsQuery(db, queryVector, limit)`. This plan **reuses it unchanged**.
  - Evidence on file: `EXPLAIN` over the drizzle-emitted SQL (via `.getSQL()`, not a hand-written
    equivalent) shows `Limit → Index Scan using builder_embeddings_hnsw_idx` with
    `Order By: (embedding <=> …)`; the pre-fix shape shows `Limit → Sort → Seq Scan`. A
    `POST /api/search/semantic` before/after returned 30 identical builders in identical order
    with identical `similarity`. `pnpm test` green (1862 tests). An EXPLAIN-based regression test
    with a negative control lives in `public-builder-embeddings.test.ts`.
  - **Correction to this task's original acceptance criterion**, for anyone reusing it: it
    required `Index Scan …` and "no `Sort` node" against "a seeded local DB". An indexable
    `ORDER BY` only makes the index *available* — the planner still costs it against a seq scan,
    and below ~2k embedded rows the seq scan legitimately wins (measured at `LIMIT 50`: 352 rows →
    seq scan at ~7 ms; 2k/5k/20k → HNSW index scan). As written the check fails on a **correct**
    query at today's corpus size. Run it with `enable_seqscan = off`, or seed past the crossover.

- [ ] **Extend the embeddings repository for multi-probe retrieval**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts`
  - Do: Add `findSimilarBuilderEmbeddingsForMatch(vectors: number[][], perProbeLimit: number)`
    returning, per probe, `{ source, sourceId, profile, document, similarity }[]` — one query per
    vector using the **same corrected ordering as the task above** (`ORDER BY embedding <=> $vec
    ASC LIMIT perProbeLimit`, similarity as a select column), `WHERE embedding IS NOT NULL`,
    `publicDb` (this table has no `organizationId`). A separate function rather than a parameter
    on the existing one because this variant also selects `document`, which evidence grounding
    needs and semantic search does not. Also add
    `findRestrictedIdentityPairs(pairs: Array<{ source: string; sourceId: string }>)` joining
    `builder_identities` → `builder_processing_restrictions` on `status = 'active'` and returning
    the restricted `(source, sourceId)` pairs — a **post-filter**, deliberately not a join inside
    the vector query, so the index path survives.
  - Verify: `pnpm type-check`; against a seeded local DB, 3 probe vectors return 3 result arrays;
    `EXPLAIN` on the `.toSQL()` output of the single-probe query shows
    `Index Scan using builder_embeddings_hnsw_idx` and no `Sort` node — run it with
    `enable_seqscan = off` (or seed past ~2k embedded rows), for the reason recorded in the
    ordering task above, and mirror the negative-control pattern already in
    `public-builder-embeddings.test.ts` so the assertion is known to discriminate.

## Phase 4 — Match service + repository

- [ ] **Add the tenant-scoped runs repository**
  - Files: `src/shared/lib/repositories/jd-match-runs.ts` (new)
  - Do: `insertJdMatchRun(tx, input)`, `findJdMatchRun(tx, organizationId, id)`,
    `listJdMatchRuns(tx, organizationId, limit)` (DTO allowlist: id, title, mode, poolSize,
    resultCount, createdAt — never `jdText`), `findRecentRunByFingerprint(tx, organizationId, fingerprint, sinceMs)`,
    `deleteJdMatchRun(tx, organizationId, id)`, `deleteExpiredJdMatchRuns(tx, now)`. Every
    function takes a `TenantTransaction` and filters on `organizationId`; never import the global
    `db`.
  - Verify: `pnpm type-check`; a grep confirms no `from '~/shared/lib/db/client'` default `db`
    import in the file.

- [ ] **Implement the two-stage match service**
  - Files: `src/lib/match/match-service.ts` (new)
  - Do: `runJdMatch({ jd, principal, entitlement })`:
    (1) `normalizeJd` → guards → `truncateJd` → `jdFingerprintOf`;
    (2) extraction — read/write `tenantAiCacheKey({ organizationId, artifact: 'match-jd-requirements', input: fingerprint })`
    (from `src/shared/lib/ai/cache.ts`, **not** `getCached`/`setCached`, which are not
    tenant-scoped), `checkAndConsumeBudget`, then `minimaxChat` with the registry definition;
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
  - Verify: `pnpm type-check`; with `E2E_MODE=true E2E_EMBEDDINGS_SCENARIO=fallback` the service
    returns `mode: 'hybrid'` or `'deterministic'` and never throws.

- [ ] **Unit-test the service's degradation ladder**
  - Files: `src/lib/match/match-service.test.ts` (new)
  - Do: Stub the embedding and MiniMax boundaries via the existing `E2E_*` scenario seams
    (`E2E_EMBEDDINGS_SCENARIO`, `E2E_AI_TASK_SCENARIO` in `embeddings.ts`/`tasks.ts`). Cover:
    warm index → `mode: 'ranked'` with 20 results; 6-row index → `hybrid`; 3-row index →
    `deterministic` and **zero** rerank calls; rerank returns an unknown `candidateId` → dropped,
    list backfilled to 20; rerank returns 100 items → schema rejects; `AI_DISABLED_TASKS` covering
    the rerank task → `deterministic`; extraction `confidence: 'low'` → `not_a_job_description`.
  - Verify: `pnpm test match-service`.

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
    `saveJobDescription`) and `settleReservation` **10** for `ranked` / **3** for
    `hybrid`|`deterministic`; on `not_a_job_description` or any failure `releaseReservation` and
    return 422/502. Never trust a client organization id; never return an ORM row.
  - Verify: `curl` as a seeded Pro Max org returns `{ runId, mode, results: [...] }` with ≤ 20
    items; as a Pro org returns `403 tier_too_low`; the same JD twice within an hour creates one
    row (`SELECT count(*) FROM jd_match_runs` unchanged) and one settled reservation.

- [ ] **Add the `match:delete` permission action**
  - Files: `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/authorization/permissions.test.ts`
  - Do: Add `'match:delete'` to the `PermissionAction` union and a `case 'match:delete': return
    resource.creatorUserId === principal.userId || elevated` arm to `can()`. A new action is
    required because the generic `resource:delete` arm needs
    `visibility === 'organization'` for a non-creator, and `jd_match_runs` has **no `visibility`
    column** — reusing it would make every run undeletable by anyone but its creator, even an
    owner, despite the run being paid for from pooled organization credits. **Reads need no new
    action**: every member of the organization may read any run (RLS plus the tenant repository
    already scope it), so `GET` routes do not call `can()`. Name chosen to avoid the actions
    other fase-2 plans introduce (`integration:read`/`integration:manage` in
    [`ats-integrations`](../ats-integrations/spec.md), `pipeline:move`/`pipeline:configure` in
    [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md)).
  - Verify: `pnpm test permissions` — creator `member` may delete their own run; a non-creator
    `member` may not; `admin` and `owner` may delete any run in the organization. The
    exhaustive-switch type check still compiles with no `default` arm.

- [ ] **Add the run read/delete routes**
  - Files: `src/routes/api/match/runs.ts` (new), `src/routes/api/match/$runId.ts` (new)
  - Do: `GET /api/match/runs` → `listJdMatchRuns` DTOs (no `jdText`). `GET /api/match/$runId` →
    `findJdMatchRun`; **404 when the run belongs to another organization**, never 403 (no
    existence leak); re-read display profiles for each `(source, sourceId)` from
    `builder_embeddings`, re-apply `findRestrictedIdentityPairs`, and render a
    `{ unavailable: true }` stub for rows that no longer exist. `DELETE /api/match/$runId` →
    `deleteJdMatchRun`, gated by `can(principal, 'match:delete', { creatorUserId: run.creatorUserId })`
    from the task above (never an inline `.role === 'x'` comparison — a boundary test forbids it).
  - Verify: `curl` a foreign run id → 404 with no body detail; DELETE as a non-creator `member`
    → 403, as an `admin` → 204; `pnpm test permissions`.

- [ ] **Prove tenant isolation against the real non-owner roles**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Add `checkJdMatchRuns()` alongside the existing `checkSprints()`: seed a run in org A,
    then as org B assert `GET /api/match/$runId` → 404, `DELETE` → 404, `GET /api/match/runs`
    excludes it; assert a spoofed `organizationId` in body/query/header is ignored; assert
    `builderhunt_app` with no `app.organization_id` set selects zero rows; assert
    `builderhunt_worker` can `DELETE` expired rows but `builderhunt_auth` and
    `builderhunt_platform` have no access at all. Register it in the runner list at the bottom of
    the file.
  - Verify: `pnpm test:api-isolation:local` — all pre-existing checks plus the new ones pass.

## Phase 6 — `/match` UI

- [ ] **Add the composer route and page**
  - Files: `src/routes/_dashboard/match/index.tsx` (new), `src/modules/match/components/MatchPage.tsx` (new)
  - Do: Route mirrors `src/routes/_dashboard/sprints/index.tsx`'s `beforeLoad` auth shape. Page
    renders a `<textarea>` (min 200 / max 32 000 chars with a live counter), the
    external-AI-processing notice **above** the textarea, a "Save this job description with the
    run" checkbox (default off), a Run button, and the run history from `GET /api/match/runs`.
    Entitlement: fetch the run endpoint's 403 reason or a small entitlement probe and render the
    locked state — a Pro Max pill linking to `/pricing`, no textarea submit. Hide the whole
    surface when `useAICapabilities()` (`~/shared/lib/ai/useAICapabilities`) reports
    `disabled || !serverAI`, exactly as `SearchPage.tsx`'s semantic toggle does. Never write the
    JD to `localStorage` and never put it in the URL.
  - Verify: Pasting 3 000 words and running shows a progress state then navigates to the run; a
    Pro-tier org sees the locked pill and cannot submit; `AI_DISABLED=true` hides `/match`
    entirely.

- [ ] **Add the run view and candidate card**
  - Files: `src/routes/_dashboard/match/$runId.tsx` (new), `src/modules/match/components/MatchRunView.tsx` (new), `src/modules/match/components/MatchCandidateCard.tsx` (new)
  - Do: Ranked list of ≤ 20 cards, each with avatar/handle/source link, a fit-score ring
    (reuse `ScoreRing` from `~/components/ui`), a verdict badge, matched/missing requirement
    chips, and 1–3 evidence rows rendering `claim` plus the quoted `citation` and a link to the
    profile source. Track/untrack reuses `POST /api/builders/track` and
    `DELETE /api/builders/$id` exactly as `SearchPage.tsx` does. Honest banners: `hybrid` → "Not
    enough indexed matches yet — live search results are mixed in"; `deterministic` → "Ranked by
    similarity only — AI ranking was unavailable for this run"; `truncated` → "Only the first
    32 000 characters were analysed"; fewer than 20 results → show the real count, never pad.
    `unavailable: true` candidates render a "no longer indexed" stub.
  - Verify: A saved run renders identically on reload; every visible citation string appears
    verbatim in the linked profile's bio/topics; the `deterministic` banner appears when the
    rerank task is disabled.

- [ ] **Add navigation and the search cross-link**
  - Files: `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `src/modules/search/components/SearchPage.tsx`
  - Do: Add `{ to: '/match', icon: <lucide icon>, label: 'Match', end: false }` to `NAV` (after
    `/search`). In `SearchPage.tsx`'s `NoResults` block only, add one line: "Hiring for a specific
    role? Paste the job description →" linking to `/match`. Change nothing else in `SearchPage`.
  - Verify: The pill appears on desktop and in `MOBILE_NAV_ITEMS`; keyword search output is
    otherwise unchanged; `pnpm lint`.

## Phase 7 — Retention, disclosure, observability

- [ ] **Purge expired runs in the existing legal worker**
  - Files: `src/shared/lib/legal.ts`, `src/routes/api/admin/legal/run-worker.ts`
  - Do: Alongside `processPendingDeletions()`, call `deleteExpiredJdMatchRuns` per organization
    inside its own tenant transaction (per security-policy: "workers acquire scope from persisted
    server-side records and execute each tenant batch in its own database transaction/context")
    and include `{ jdMatchRunsPurged }` in the worker's JSON response. **No new endpoint and no
    new cron** — the daily legal cron already exists.
  - Verify: Insert a run with `expiresAt` in the past; authed
    `curl -X POST /api/admin/legal/run-worker` reports `jdMatchRunsPurged: 1`; a second call
    reports 0 (idempotent).

- [ ] **Disclose external AI processing of job descriptions**
  - Files: `src/routes/_landing/legal/privacy.tsx`
  - Do: Add an explicit line to the processor list stating that pasted job-description text is
    sent to the configured external AI provider for requirement extraction and candidate ranking,
    is retained only when the user opts in, and is otherwise kept as a non-reversible fingerprint
    for up to 90 days. Bump `CURRENT_CONSENT_VERSIONS` in `src/shared/lib/legal.ts` only if the
    project's versioning rule requires it for a processor-list change.
  - Verify: `/legal/privacy` renders the new line; `pnpm test legal`.

- [ ] **Add match observability counters**
  - Files: `src/lib/match/match-service.ts`, `src/routes/api/match/run.ts`
  - Do: Emit structured `log.info`/`log.warn` (`src/shared/lib/log.ts`) with an allowlist only:
    `taskId`, `provider`, `mode`, `poolSize`, `resultCount`, `droppedEvidence`,
    `unknownCandidateIds.length`, `latencyMs`, `settledUnits`, redacted
    `organizationId`/`requestId`. Warn when `droppedEvidence / totalEvidence > 0.10` or when any
    unknown candidate id appears. **Never log the JD, a prompt, or a model response.**
  - Verify: A run logs one line with no JD substring present (`grep` the captured log for a
    distinctive phrase from the test JD → no match).

- [ ] **Quality gate before the rate card goes live**
  - Files: `plans/fase-2/jd-to-candidates-matching/plan.md` (record the outcome in Risks)
  - Do: Hand-label 20 real JDs against a warm index and compare the AI reranked top-20 against
    the pure RRF top-20 (precision@10 on the labels). If the reranker does not measurably beat
    the deterministic order, ship `mode: 'deterministic'` as the default and settle 3 credits
    instead of 10 rather than charging for no gain.
  - Verify: The comparison numbers are recorded in this plan before Pro Max is enabled anywhere.

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm test && pnpm type-check && pnpm lint && pnpm test:rls:local && pnpm test:api-isolation:local`
    plus `node scripts/db/verify-migration-integrity.mjs` and `pnpm exec drizzle-kit check`.
    Then exercise the degradation matrix end to end: warm index → `ranked`; empty index →
    `hybrid`; `AI_DISABLED_TASKS=match-jd-rerank` → `deterministic`; `AI_DISABLED=true` → `/match`
    hidden and `POST /api/match/run` → 503 with **zero** reservations created
    (`SELECT count(*) FROM billing_credit_reservations WHERE operation = 'jd_match'` unchanged);
    unentitled org → 403 with zero reservations.
  - Verify: All green; the reservation count invariant holds in every failure case.
