# Look-alike Sourcing (tasks)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../phase-1/22-semantic-search/tasks.md) (global `builder_embeddings` + pgvector HNSW — already shipped); [`proactive-discovery`](../../phase-1/23-proactive-discovery/tasks.md) (index breadth; already shipped — a thin index makes look-alikes weak but must not break them). Enhanced by [`collaboration-graph`](../collaboration-graph/spec.md) and [`availability-signals`](../availability-signals/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: Extends shipped files only — `src/lib/semantic/embedding-doc.ts`, `src/lib/dedup.ts`, `src/shared/lib/repositories/public-builder-embeddings.ts`, `src/shared/lib/billing-shared.ts`, `src/modules/search/components/{PersonResultCard,SearchPage}.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/modules/dashboard/ui/shell/nav-config.ts`, `scripts/db/verify-api-isolation-local.mjs`. All verified to exist at HEAD 2026-07-27. No new table, no migration, no new env var, no entry in `AI_TASKS`.

Ordered so the app ships cleanly after every checkbox.

**Conventions for this file.** Unit tests live under `tests/unit/**` mirroring `src/` — there are no
co-located tests in this repo and `vitest.config.ts` only includes `tests/unit/**`. `Verify:` steps
name the full test path so `pnpm test <path>` filters unambiguously. Every write this plan performs
goes to `builder_embeddings`, whose grant is
`GRANT SELECT, INSERT, UPDATE ON TABLE builder_embeddings TO builderhunt_app`
(`drizzle/0025_public_tables_app_grants.sql:19`) — no `DELETE` is used and none is granted; the
table has no RLS and no `organization_id`.

## Phase 1 — Index payload enrichment (invisible, zero embedding cost)

- [ ] **Add optional `kind` and `lastActiveAt` to the stored embedding payload**
  - Files: `src/lib/semantic/embedding-doc.ts`
  - Do: Extend `embeddedProfileSchema` with `kind: z.enum(['person', 'repo']).optional()` and
    `lastActiveAt: z.number().int().optional()` (epoch ms). Extend `EmbeddableSource` with
    `kind?: string | null` and `metadata?: Record<string, unknown> | null` — `RawBuilder` already
    satisfies both structurally, so no call site changes. In `toEmbeddedProfile`, set
    `kind: profile.kind === 'repo' ? 'repo' : profile.kind === 'person' ? 'person' : undefined`
    and `lastActiveAt: typeof profile.metadata?.lastSeen === 'number' ? profile.metadata.lastSeen : undefined`.
  - Do NOT touch `buildEmbeddingDoc` or `contentHashOf` — a changed document invalidates every
    `content_hash` and re-embeds the entire index.
  - Verify: `pnpm test tests/unit/lib/semantic/embedding-doc.test.ts` and `pnpm type-check`.

- [ ] **Lock the content hash against accidental re-embed**
  - Files: `tests/unit/lib/semantic/embedding-doc.test.ts`
  - Do: Add a test asserting `contentHashOf(buildEmbeddingDoc(fixture))` equals a hard-coded
    sha256 literal for a fixed fixture profile, and that adding `kind`/`lastActiveAt`/`metadata`
    to that fixture does not change it. Compute the literal once by running the expression against
    the fixture — do not guess it. Add a test that `toEmbeddedProfile` round-trips both new fields
    and omits them when absent (`kind` must be `undefined`, not `'person'`, for a source that
    reports neither).
  - Verify: `pnpm test tests/unit/lib/semantic/embedding-doc.test.ts` — the hash test fails loudly
    if anyone edits the document template later.

- [ ] **Confirm the payload backfills without a migration**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts` (read-only check)
  - Do: Re-read `upsertBuilderEmbeddingStub`'s `onConflictDoUpdate` (lines 37–47): `profile` is
    always set to `sql\`excluded.profile\`` while `embedding`/`embeddedAt` are hash-gated behind
    `case when content_hash = excluded.content_hash …`. The column is `jsonb` with a
    `$type<EmbeddedProfile>()` brand only, so widening the TS type needs no DDL. Note it in the PR
    description.
  - Verify: record `jq '.entries | length' drizzle/meta/_journal.json` and
    `ls drizzle/*.sql | wc -l`, run `pnpm db:generate`, then re-run both — **both counts must be
    unchanged**. Do not use "`git status drizzle/` is clean" as the check: the working tree may
    already carry untracked migration WIP, which would make that test fail for an unrelated reason.
    This plan creates no migration, so there is no `drizzle-kit generate --custom` step anywhere in
    it.

## Phase 2 — Pure libs: scoring, collapse, explanation, seed doc

- [ ] **Add the shared identity key to the deduper without changing its behaviour**
  - Files: `src/lib/dedup.ts`, `tests/unit/lib/dedup.test.ts` (new)
  - Do: Add `export function identityKey(username: string): string { return username.toLowerCase().replace(/[^a-z0-9]/g, '') }`
    to `src/lib/dedup.ts`. **Leave `deduplicateBuilders`' own key as `builder.username.toLowerCase()`
    (line 6).** Swapping it to `identityKey` would merge `foo-bar` into `foobar` in the live
    federated search path (`src/lib/search.ts:106` is the only caller) — a user-visible result
    change this plan does not need. The two keys differ deliberately; spec.md records why.
  - Verify: `pnpm test tests/unit/lib/dedup.test.ts` — asserts
    `identityKey('Edd-Remonts') === 'eddremonts'`, that `deduplicateBuilders` given `RawBuilder`s
    named `Edd-Remonts` and `eddremonts` still returns **two** entries, and that the existing
    follower-max / topic-union / avatar-and-bio-preference merge semantics for two rows with the
    same lowercased username are unchanged.

- [ ] **Implement the hybrid look-alike score (pure)**
  - Files: `src/lib/similar/lookalike-score.ts` (new),
    `tests/unit/lib/similar/lookalike-score.test.ts` (new)
  - Do: Export `LookAlikeSignals`, `LOOKALIKE_WEIGHTS = { vector: 0.55, topicOverlap: 0.25,
    languageMatch: 0.08, magnitude: 0.07, recency: 0.05 }`, `signalsFor(seed, candidate, now)` and
    `scoreLookAlike(...) => Math.round(100 * Σ w*s)`. Topic overlap = Jaccard over
    lowercased/trimmed topic sets (empty on both sides ⇒ `0.5`, not `NaN`); language 1/0.5/0
    (equal / unknown either side / different); magnitude
    `1 - Math.min(1, Math.abs(Math.log10(1+a) - Math.log10(1+b)) / 2)`, `0.5` when either
    `followersCount` is absent; recency buckets `<7d 1 | <30d .8 | <90d .5 | <365d .2 | else 0`,
    `0.5` when `lastActiveAt` is absent. `now` is an injected epoch-ms parameter so the module stays
    pure and the tests stay deterministic.
  - Verify: `pnpm test tests/unit/lib/similar/lookalike-score.test.ts` — asserts
    `Object.values(LOOKALIKE_WEIGHTS).reduce((a, b) => a + b, 0) === 1`, identical profiles at
    vector 1 score 100, disjoint profiles at vector 0 with all fields known score 0, and a
    candidate with every optional field absent lands on the neutral 0.5 for
    `topicOverlap`/`languageMatch`/`magnitude`/`recency`.

- [ ] **Implement deterministic per-result reasons (pure, no LLM)**
  - Files: `src/lib/similar/lookalike-score.ts`, `tests/unit/lib/similar/lookalike-score.test.ts`
  - Do: `explainLookAlike(seed, candidate, now): string[]` returning at most 3 strings in priority
    order — shared topics (`"4 shared topics: rust, wasm, compilers, +1"`), same language
    (`"Both primarily Rust"`), recency when known and ≤ 30 days (`"Active in the last 7 days"`),
    similar reach (`"Similar reach (~2k vs ~3k followers)"`). No reason may echo raw bio text; the
    only free text that may appear is a topic name, a language name and a rounded follower count.
  - Verify: `pnpm test tests/unit/lib/similar/lookalike-score.test.ts` — a candidate sharing
    nothing yields `[]`; a candidate sharing everything yields exactly 3 reasons in the documented
    order; a candidate whose bio contains `"<script>"` produces no reason containing it.

- [ ] **Implement identity collapse (pure)**
  - Files: `src/lib/similar/identity-collapse.ts` (new), `tests/unit/lib/similar/identity-collapse.test.ts` (new)
  - Do: `normalizeDisplayName(name)` (lowercase, collapse whitespace, strip punctuation) and
    `collapseLookAlikes(seed, scored)` where
    `seed: { source: string; sourceId: string; username: string; displayName?: string } | null`
    (`null` for the `text` mode, which has no identity). Applying, in order: drop the seed's own
    `(source, sourceId)`; drop `kind === 'repo'` (keep `undefined`); drop
    `identityKey(candidate.username) === identityKey(seed.username)`; drop equal normalized
    display names when both have ≥ 2 tokens; then group survivors by `identityKey`, keep the
    highest `matchScore` as representative, union topics, and put the rest in `collapsedFrom` as
    `"source:sourceId"` strings. Steps 1, 3 and 4 are no-ops when `seed` is `null`.
    Import `identityKey` from `~/lib/dedup`. Return
    `{ results, collapsedCount, selfHitsSuppressed, repoRowsDropped }`.
  - Verify: `pnpm test tests/unit/lib/similar/identity-collapse.test.ts` — regression fixture: a
    seed GitHub profile plus the same person on DEV.to and Hashnode with a copy-pasted bio at
    similarity 0.98 must produce zero results from those three rows and `selfHitsSuppressed: 3`.
    Second case: the same fixture with `seed: null` keeps the two non-seed rows collapsed into one
    representative with the other in `collapsedFrom`, and `selfHitsSuppressed: 0`.

- [ ] **Implement the pasted-seed document builder (pure)**
  - Files: `src/lib/similar/seed-doc.ts` (new), `tests/unit/lib/similar/seed-doc.test.ts` (new)
  - Do: `buildSeedDocFromText({ text, topics?, language? }): string` emitting the same line
    grammar as `buildEmbeddingDoc` (`src/lib/semantic/embedding-doc.ts`) minus `Name:`/`Source:` —
    `Bio: <whitespace-collapsed text>`, then `Language:` and `Topics: a, b, c` when provided, in
    that order, joined with `\n` — truncated to 6000 chars with `.slice(0, 6000)`, matching
    `MAX_DOC_LENGTH`. Pure: no I/O, no logging.
  - Verify: `pnpm test tests/unit/lib/similar/seed-doc.test.ts` — line order matches
    `buildEmbeddingDoc`'s relative order, a 10k-char input yields a string of length exactly 6000,
    and empty/absent optional fields emit no line.

## Phase 3 — Repository + `indexed`/`tracked` modes behind the API

- [ ] **Add the seed lookup and index-size count to the public repository**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts`
  - Do: `findBuilderEmbeddingSeed(source, sourceId): Promise<{ embedding: number[]; profile: EmbeddedProfile; embeddedAt: Date | null } | null>`
    selecting on `builder_embeddings_source_unique`, and `countEmbeddedBuilders(): Promise<number>`
    (`count(*) where embedding is not null`, wrapped in a 5-minute Redis cache keyed
    `lookalike:index-count`, falling through to a live count when Redis is absent). Use `publicDb`
    only — this table has no `organization_id` and no RLS; `SELECT` is granted to
    `builderhunt_app` by `drizzle/0025_public_tables_app_grants.sql:19`.
  - Verify: `pnpm type-check` and `pnpm security:boundaries` (the repository is the only layer
    allowed near `publicDb`).

- [x] **Make the vector search index-eligible (shared with semantic-search)** — **DONE, shipped
      outside phase 2** in commit `24a280b`. Re-confirmed at HEAD 2026-07-27:
      `src/shared/lib/repositories/public-builder-embeddings.ts:112` is `.orderBy(asc(distance))`,
      with ``similarity: sql<number>`1 - (${distance})` `` kept as a *selected* column (line 108),
      and the builder is exported as `similarBuilderEmbeddingsQuery(db, queryVector, limit)`
      (line 101) so callers and tests can EXPLAIN the SQL the module actually emits.
      `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` asserts
      `Index Scan using builder_embeddings_hnsw_idx` under `SET LOCAL enable_seqscan = off`, with a
      negative control on the old derived-descending shape. This plan **reuses
      `findSimilarBuilderEmbeddings` unchanged**; do not re-apply the change.
  - Note on `SET LOCAL hnsw.ef_search = 100`: this plan does **not** set it. The original rationale
    — "`ef_search` must be ≥ the requested `LIMIT` (default 40 would silently under-return at
    `LIMIT 60`)" — is **false** on pgvector 0.8.5, which searches with `ef = max(ef_search, limit)`.
    Measured with `EXPLAIN (ANALYZE)` on a 5k-row HNSW index at `ef_search = 40`, index scan
    chosen: `LIMIT 50 → 50 rows`, `LIMIT 60 → 60 rows`, `LIMIT 100 → 100 rows`. Add it only as a
    deliberate recall-quality decision, never justified by an under-return.
  - Also note: an indexable `ORDER BY` makes the index *available*, not mandatory. The planner
    still costs it against a seq scan, and below ~2k embedded rows the seq scan wins (measured:
    352 rows → seq scan ~7 ms; 2k/5k/20k → index scan). Any `EXPLAIN` acceptance check needs either
    `enable_seqscan = off` or a corpus past that crossover, or it will fail on a correct query.
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts` (already shipped — read only)
  - Do: nothing. Re-confirm the checkbox before trusting it.
  - Verify: `grep -n "orderBy(asc(distance))" src/shared/lib/repositories/public-builder-embeddings.ts`
    returns line 112, and
    `pnpm test tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` passes all
    three cases. If either fails, the change was reverted, this plan's core premise is broken and
    its p95 target is void — uncheck this box and stop.

- [x] **Prove the shared change does not disturb semantic search (exact regime)** — **DONE.** `POST
      /api/search/semantic` was captured before and after the ordering change against the local
      index (352 embedded rows), through real Better Auth sign-up and a `pro` entitlement:
      **30 builders, identical order, identical `similarity` values, element for element**, with
      `mode: "semantic"` both times. A repository-level A/B over three probe vectors at `LIMIT 50`
      likewise returned 50/50 identical rows. Zero membership delta — expected, since at this
      corpus size the planner still chooses the seq scan, so retrieval was exact in both runs.
      `tests/e2e/semantic-search.spec.ts` now covers the route end to end and records this history.
  - Files: none (measurement record)
  - Do: nothing. The still-open indexed-regime run was split out into the next task rather than
    left hidden under this checked box.
  - Verify: `pnpm test:e2e tests/e2e/semantic-search.spec.ts` passes — the automated successor to
    the manual before/after HTTP comparison, exercising the real
    `semantic.ts → semantic-search.ts → public-builder-embeddings.ts` chain against a migrated
    disposable Postgres with the production HNSW index.

- [ ] **Re-run the semantic-search A/B in the *indexed* regime**
  - Files: none (measurement only)
  - Do: The checked task above only proved the exact/seq-scan regime, so it is **not** evidence for
    the approximate one. Grow the local `builder_embeddings` corpus past the ~2k-row crossover (run
    the discovery worker, or bulk-insert synthetic rows with the same dimension as the migrated
    `embedding` column — read it from
    `select atttypmod from pg_attribute where attrelid = 'builder_embeddings'::regclass and attname = 'embedding'`,
    which is what the repository test does). Then capture `POST /api/search/semantic` for a fixed
    query and compare the result set against the same query run with
    `SET LOCAL enable_seqscan = off` disabled and forced-exact retrieval. Record the membership
    delta in the PR description. A non-empty tail delta is expected and acceptable; a change in the
    top 10 is not, and would mean raising `hnsw.ef_search` for the semantic path.
  - Verify: `EXPLAIN ANALYZE` on the emitted query shows
    `Index Scan using builder_embeddings_hnsw_idx` **without** `enable_seqscan = off` (that is the
    proof the corpus is actually past the crossover), and the recorded top-10 sets are identical.

- [ ] **Implement the look-alike orchestrator (seed modes only)**
  - Files: `src/lib/similar/lookalike.ts` (new), `tests/unit/lib/similar/lookalike.test.ts` (new)
  - Do: Export `LOOKALIKE_CANDIDATE_LIMIT = 60`, `LOOKALIKE_SIMILARITY_FLOOR = 0.55`,
    `LOOKALIKE_MIN_RESULTS = 5`, `LOOKALIKE_MIN_INDEX_ROWS = 500`, `LOOKALIKE_RESULT_LIMIT = 20`
    and `findLookAlikes({ seed, principal, entitlement })`, where `principal` is
    `Pick<TenantPrincipal, 'organizationId' | 'userId'>` and `entitlement` is
    `Pick<EntitlementPolicy, 'tier'>` — the same narrow shapes `semanticSearch` takes. They are
    unused by the seed modes but required by Phase 4's budget call, and threading them now avoids a
    signature change later. Flow: `countEmbeddedBuilders()` → `index_warming` when below
    `LOOKALIKE_MIN_INDEX_ROWS`; resolve the seed vector via `findBuilderEmbeddingSeed` → `pending`
    when the row is missing or `embedding` is null; `findSimilarBuilderEmbeddings(vector,
    LOOKALIKE_CANDIDATE_LIMIT)` → drop below `LOOKALIKE_SIMILARITY_FLOOR` → `scoreLookAlike` →
    `collapseLookAlikes` → sort by `matchScore` desc → slice to `LOOKALIKE_RESULT_LIMIT` → `ok`
    when ≥ `LOOKALIKE_MIN_RESULTS` else `weak`. Import only from
    `~/shared/lib/repositories/public-builder-embeddings` — never from `~/shared/lib/db/index`, or
    `pnpm security:boundaries` fails.
  - Verify: `pnpm test tests/unit/lib/similar/lookalike.test.ts` with the repository functions
    stubbed via `vi.mock('~/shared/lib/repositories/public-builder-embeddings')` — asserts each of
    the four statuses and that results are ordered by `matchScore`, not raw `similarity` (use a
    fixture where the two orders differ, or the assertion proves nothing).

- [ ] **Upsert a stub for an unindexed seed**
  - Files: `src/lib/similar/lookalike.ts`, `tests/unit/lib/similar/lookalike.test.ts`
  - Do: When `findBuilderEmbeddingSeed` returns null and the caller supplied a resolved public
    profile, call `upsertEmbeddingStubs([profile])` from `~/lib/semantic/index-writer` (awaited —
    the response depends on it having happened) and return `pending`. This is the only write this
    feature performs, and only ever for already-public profile data. Grant check:
    `upsertBuilderEmbeddingStub` issues `INSERT … ON CONFLICT DO UPDATE` on `builder_embeddings`
    under `publicDb`/`builderhunt_app`, covered by
    `GRANT SELECT, INSERT, UPDATE ON TABLE builder_embeddings TO builderhunt_app`
    (`drizzle/0025_public_tables_app_grants.sql:19`) — the same grant `/api/search/builders`'
    write-through already exercises in production. No RLS policy applies (the table has none).
  - Verify: `pnpm test tests/unit/lib/similar/lookalike.test.ts` — a `vi.mock`ed writer is called
    exactly once for a missing seed and **never** for the `text` mode (the executable guard test
    lands in Phase 6).

- [ ] **Add `POST /api/search/similar` with the tenant + plan gates**
  - Files: `src/routes/api/search/similar.ts` (new)
  - Do: Mirror `src/routes/api/search/semantic.ts`: `requireTenantPrincipal` →
    `withTenantContext(principal, tx => getOrganizationEntitlement(tx, principal.organizationId))`
    → `403 { error: 'plan' }` when `tier === 'free'` → `rateLimit('search-similar', principal.userId, 30, 60)`
    → parse the `SimilarBody` discriminated union (`indexed` | `tracked`; `text` in Phase 4) →
    `findLookAlikes` → annotate with `getTrackedBuilderIds` + `trackedKey`. Return the
    `LookAlikeResponse` DTO allowlist from spec.md (never a raw row); `pending` → 202, everything
    else → 200. Never read `organizationId` from the body.
  - Verify: `pnpm security:route-coverage` passes (the route is not allowlisted as public, so it
    must contain `requireTenantPrincipal` — the check greps for exactly that); then
    `curl -X POST localhost:3000/api/search/similar -H 'Content-Type: application/json' -d '{"kind":"indexed","source":"github","sourceId":"1"}'`
    returns 401 unauthenticated, 403 `{"error":"plan"}` as a free org, and a `status` field as a
    Pro org.

- [ ] **Resolve the `tracked` seed server-side**
  - Files: `src/routes/api/search/similar.ts`
  - Do: For `kind: 'tracked'`, resolve `builderId` inside `withTenantContext` via
    `findOrganizationBuilderByEitherId(tx, principal.organizationId, builderId)` (its
    `privateBuilderFields` projection already returns `source`/`sourceId`), falling back to
    `findPublishedBuilderProfile(builderId)` for claimed public profiles. `404` when neither
    resolves — never leak whether another organization tracks that id.
  - Verify: `pnpm test:api-isolation:local` after Phase 6's check is added; manually, org A asking
    for org B's private `builderId` gets 404 with no timing/existence difference from an unknown id.

- [ ] **Reject non-person seeds**
  - Files: `src/routes/api/search/similar.ts`, `src/lib/similar/lookalike.ts`
  - Do: When the resolved seed payload has `kind === 'repo'`, return
    `400 { error: 'seed_not_a_person' }`. Repos legitimately live in `builder_embeddings`:
    `src/lib/sources/{github,npm,gitlab,codeberg,huggingface}.ts` all emit `kind: 'repo' as const`,
    `src/lib/search.ts` does not filter on `kind`, and `src/routes/api/search/builders.ts:92`
    write-throughs the unfiltered result array.
  - Verify: `pnpm test tests/unit/lib/similar/lookalike.test.ts` covers the repo-seed rejection,
    and `tests/unit/lib/similar/identity-collapse.test.ts` covers candidate-side repo dropping with
    `kind: undefined` rows kept.

## Phase 4 — Pasted-seed mode + allowance gating

- [ ] **Add the paste allowance to the shared billing table**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: Next to `SOURCING_SPRINT_LIMITS` (line 54), add:
    ```ts
    // Pasted-seed look-alike searches per organization per UTC day. Keyed by
    // OrganizationTier and read with `entitlement.tier` directly — see the
    // SOURCING_SPRINT_LIMITS comment above and resolveLegacyPlanTier's own
    // "do NOT reach for this when the allowance is advertised" note.
    export const LOOKALIKE_PASTE_LIMITS: Record<OrganizationTier, number> = {
      free: 0, pro: 20, pro_max: 100, team: 100,
    }
    ```
    Do **not** key it by `PlanTier` and do **not** route it through `resolveLegacyPlanTier`: that
    is the shape `SOURCING_SPRINT_LIMITS` was migrated *away* from after it drifted by 7 sprints
    (`src/shared/lib/billing-shared.ts` lines 44–54).
  - Verify: `pnpm type-check` — the `Record<OrganizationTier, …>` type makes a missing `pro_max`
    key a compile error, which is the whole point.

- [ ] **Embed the pasted seed ephemerally, metered, org-scoped cached**
  - Files: `src/lib/similar/lookalike.ts`, `tests/unit/lib/similar/lookalike.test.ts`
  - Do: For `kind: 'text'`, build the doc with `buildSeedDocFromText`, look up
    `ai:cache:lookalike-seed:{organizationId}:{sha256(doc)}` in Redis (TTL 3600), and on a miss
    call `checkAndConsumeBudget` **and then** `embedTexts([doc])` — both inside the *same*
    top-level function, in that order:
    ```ts
    // src/lib/similar/lookalike.ts — mirrors src/lib/semantic/semantic-search.ts:28,88-94
    const LOOKALIKE_SEED_EMBED_ALLOWANCES: Record<PlanTier, number> = { free: 0, pro: 40, team: 200 }
    const budget = await checkAndConsumeBudget(principal, entitlement, {
      id: 'lookalike-seed-embed', allowances: LOOKALIKE_SEED_EMBED_ALLOWANCES,
    })
    if (!budget.allowed) throw new LookAlikeBudgetError()
    const [vector] = await embedTexts([doc])
    ```
    This is **not optional**: `scripts/check-provider-metering.mjs` fails the build for any
    `embedTexts(` not preceded by `checkAndConsumeBudget(`/`reserveCredits(` within the same
    brace-depth-0 scope, and its file allowlist is for non-tenant-billed surfaces only. The inline
    task object keeps `AI_TASKS` untouched — `checkAndConsumeBudget` only needs
    `Pick<AITaskDefinition, 'id' | 'allowances'>`, and `allowances` there is genuinely
    `Record<PlanTier, number>` because the budget module resolves `pro_max` itself. Store only the
    vector in Redis. **Never** call `upsertEmbeddingStubs` on this path and never write the text
    anywhere. The cache key is organization-scoped on purpose — `semantic-search`'s global
    `ai:cache:query-embed:*` key (`src/lib/semantic/semantic-search.ts:76`) is wrong for private
    text (`_meta/security-policy.md` line 116: cache keys include the server-resolved organization
    ID).
  - Verify: `pnpm security:provider-metering` passes; `pnpm test tests/unit/lib/similar/lookalike.test.ts`
    — a spy on the index writer is never called for `text` mode; two calls with the same text in
    the same org produce one `embedTexts` call; the same text in a *different* org produces a
    second one (this is the test that proves the key is org-scoped, not global).

- [ ] **Gate paste mode on tier, allowance and provider availability**
  - Files: `src/routes/api/search/similar.ts`
  - Do: Accept the `text` branch (`min(120).max(6000)` plus optional `topics`/`language`).
    `400 { error: 'seed_too_short' }` below 120 chars. Enforce
    `rateLimit('lookalike-paste', principal.organizationId, LOOKALIKE_PASTE_LIMITS[entitlement.tier], 86400)`
    → `429 { error: 'paste_allowance' }` with `Retry-After`. Map a `LookAlikeBudgetError` to
    `429 { error: 'seed_embed_budget' }`, kept distinct so the two ceilings are distinguishable in
    support. Catch embedding failures (`AIEmbeddingUnavailableError`, `AIDimensionMismatchError`,
    both from `~/shared/lib/ai/errors`) → `503 { error: 'seed_embedding_unavailable' }` without
    touching the seed modes.
  - Verify: `curl` a 50-char paste → 400 `seed_too_short`; 21 pastes in a day as a Pro org → the
    21st returns 429 `paste_allowance`; unset `AI_EMBEDDING_URL` → paste returns 503 while
    `{"kind":"indexed",...}` still returns 200.

- [ ] **Never log the pasted text**
  - Files: `src/lib/similar/lookalike.ts`, `src/routes/api/search/similar.ts`
  - Do: Log `log.info('lookalike_query', { seedKind, status, chars, seedHash, candidates, kept })`
    only. `src/shared/lib/log.ts:27`'s `sensitiveKey` regex covers `bio`/`prompt`/`displayname`
    (and `profileurl`, `payload`, `response`, `location`) but **not** a key named `text`, so
    passing the text would leak it verbatim into logs. This is code discipline, not something
    redaction saves us from.
  - Verify: `grep -n "log\.\(info\|warn\|error\)" src/lib/similar/lookalike.ts src/routes/api/search/similar.ts`
    and confirm no call site passes a `text` key or a bio-derived string — zero matches for
    `text:` inside a `log.` argument; then run a paste request in dev and confirm the emitted line
    contains `chars`/`seedHash` and no prose.

## Phase 5 — UI integration

- [ ] **Add the "Similar builders" card to the builder profile**
  - Files: `src/modules/builder-profile/components/SimilarBuildersCard.tsx` (new),
    `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: New card component posting `{ kind: 'tracked', builderId }` to `/api/search/similar`,
    rendering the top 5 with a `% match` chip (`matchScore`, tooltip carrying
    `vectorSimilarity` and "Profile-text similarity plus shared topics, language and reach"),
    the reason lines, `collapsedFrom` as "also on DEV.to, Hashnode", and a "See all" link to
    `/similar?builderId=…`. Render the four statuses explicitly. Mount it inside the left column's
    `<div className="space-y-6">` at `BuilderProfilePage.tsx:324`, after `HygieneCard` and
    `CodeStyleCard`.
  - Verify: `pnpm dev`, open `/builder/<trackedIdentityId>` as a Pro org — the card lists matches
    and the profile's own person never appears in it.

- [ ] **Add an optional "Similar" action to the shared result card**
  - Files: `src/modules/search/components/PersonResultCard.tsx`,
    `src/routes/_dashboard/sprints/new.tsx`, `src/routes/_dashboard/sprints/$sprintId/index.tsx`
  - Do: The component signature at `PersonResultCard.tsx:81` is
    `PersonResultCard({ builder }: { builder: PersonCardData })`. Widen it to
    `{ builder, similarHref }: { builder: PersonCardData; similarHref?: string }` — the optional
    prop goes on the **component props**, not on the `PersonCardData` interface — and render a
    "Similar" ghost link beside "View" **only when provided** (reuse the existing
    `btn-ghost btn-sm …` class string at line 127 so focus styles match). Pass it from the two
    sprint call sites (`sprints/new.tsx:581`, `sprints/$sprintId/index.tsx:260`).
    `src/routes/_landing/explore/index.tsx` (lines 365 and 481) passes nothing, so the anonymous
    public page is unchanged — which matters, because the endpoint requires a tenant principal and
    a link there would 401.
  - Verify: `pnpm type-check`; `pnpm dev` → `/explore` renders no "Similar" link; a sprint result
    row links to `/similar?source=…&sourceId=…`.

- [ ] **Add the action to the search page's own card**
  - Files: `src/modules/search/components/SearchPage.tsx`
  - Do: `SearchPage` defines a **local** `PersonResultCard` at line 1345 —
    `function PersonResultCard({ builder, query, onToggleTrack, tracking }: …)` — which shadows the
    shared component and is what search results actually render (via line 1290). Add the same
    "Similar" link there, gated on the same Pro check the semantic toggle already uses (locked +
    "Pro" pill → `/pricing` for free tier).
  - Verify: `pnpm dev` → `/search`, run a query, each row shows "Similar" for a Pro org and a
    locked pill for a free org.

- [ ] **Add the `/similar` page hosting both modes**
  - Files: `src/routes/_dashboard/similar.tsx` (new),
    `src/modules/similar/components/SimilarSourcingPage.tsx` (new)
  - Do: Read `?source=&sourceId=` / `?builderId=` and render a seed header + results; with no
    params render the paste box (textarea, optional topics, optional primary language) with the
    copy "Used once to find matches. Not stored." Render `index_warming` with the indexed count
    and links to `/search` and `/sprints`; `weak` with "Only N close matches — treat as
    exploratory"; `pending` with the check-back copy. Include an inline track button reusing
    `/api/builders/track`. Hide the paste box when the embedding provider is unavailable while
    keeping seed results working.
  - Verify: `pnpm dev` → `/similar` with an empty index shows `index_warming` and never a list;
    pasting a real 300-char bio returns a ranked list.

- [ ] **Add the nav entry and the pricing promise**
  - Files: `src/modules/dashboard/ui/shell/nav-config.ts`, `src/shared/lib/billing-shared.ts`
  - Do: The floating-topbar `NAV` array in `DashboardLayout.tsx` **no longer exists** — commit
    `1e2ac57` replaced it with shell C's registry. In `nav-config.ts`'s `discover` area
    (`id: 'discover'`, currently `routes: ['/search', '/solutions', '/builder']`), make **two**
    changes: append `'/similar'` to `routes`, and add
    `{ to: '/similar', label: 'Look-alikes', icon: UsersRound, group: 'Discover' }` to `items`.
    `NavItem` is `{ to, label, icon, group?, badge?, exact? }` — there is no `end` field. Import
    `UsersRound` from `lucide-react` alongside the existing icon set at the top of the file.
    Omitting the `routes` entry makes `resolveActiveArea('/similar')` fall back to `home`, which
    fails the registry-integrity test. Separately, add the plain string `'Look-alike sourcing'` to
    `PLAN_PRICING.pro.features`'s `compactFeatures(...)` list — numberless on purpose, so there is
    no advertised figure that can drift from `LOOKALIKE_PASTE_LIMITS` (conventions rule 8).
  - Verify: `pnpm test tests/unit/modules/dashboard/ui/shell/nav-config.test.ts` — in particular
    "keeps every destination inside an area that owns its prefix or is reachable", which is the
    case that catches a missing `routes` entry; then `pnpm type-check` and `pnpm dev` → the
    Discover panel lists Look-alikes and `/pricing` shows the feature under Pro.

## Phase 6 — Isolation proof, docs, observability

- [ ] **Extend the API isolation harness**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Add `checkSimilarSourcing()` next to `checkSearchTrackedAnnotationScoping()` (defined at
    line 367) and register it in `main()` beside the existing `await checkSearchTrackedAnnotationScoping()`
    call (line 1229), covering: unauthenticated → 401; authenticated with no active organization →
    403; free-tier org → 403 `plan`; `organizationId` injected into the body is ignored; org A
    posting `{ kind: 'tracked', builderId }` for a builder only org B tracks → 404 that is
    indistinguishable from an unknown id; and the same `indexed` seed requested by orgs A and B
    returns identical public rows but org-specific `tracked`/`trackedRowId` annotations.
  - Verify: `pnpm test:api-isolation:local` — all checks pass against the non-owner
    `builderhunt_app` role (which is what proves the grants in
    `drizzle/0025_public_tables_app_grants.sql` are sufficient and no owner-only privilege snuck
    in), and the total check count increases.

- [ ] **Assert the pasted seed never reaches the global index**
  - Files: `tests/unit/lib/similar/lookalike.test.ts`
  - Do: A dedicated test that `vi.mock`s `~/lib/semantic/index-writer` and asserts
    `upsertEmbeddingStubs` is not called for `kind: 'text'` under **any** status branch —
    `index_warming`, `pending`, `ok`, `weak` — and that no `builder_embeddings` write occurs. This
    is the executable form of `_meta/security-policy.md` line 118, "global public embeddings
    contain only approved public-source data and never tenant notes, searches, private
    enrichments, or contact data".
  - Verify: `pnpm test tests/unit/lib/similar/lookalike.test.ts`.

- [ ] **Update the architecture docs**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: In data-classification, record that this feature adds **no table** and note the ephemeral
    pasted seed (tenant-supplied text, never persisted, org-scoped 1-hour vector cache, excluded
    from the global-public index by policy). In the authorization matrix, add
    `POST /api/search/similar` under "Product actions": tenant principal required, any
    organization role, `free` tier denied, per-user 30/min, per-org daily paste allowance, and the
    per-user `lookalike-seed-embed` budget.
  - Verify: `grep -n "/api/search/similar" docs/architecture/authorization-matrix.md docs/architecture/data-classification.md`
    returns a hit in each file. (Markdown is untouched by `pnpm lint`, so this grep is the check.)

- [ ] **Add the structured observability event**
  - Files: `src/lib/similar/lookalike.ts`
  - Do: Emit `log.info('lookalike_query', { seedKind, status, indexedCount, candidates,
    collapsedCount, selfHitsSuppressed, repoRowsDropped, kept, durationMs })` on every request.
    These are the fields the spec's success metrics are measured from. All are scalars — no
    profile prose, no `text` key. No metrics counter is added: `src/shared/lib/metrics.ts:4` has a
    closed `Counters` interface and the admin metrics page reads it, so widening it is
    deliberately out of scope.
  - Verify: `pnpm dev`, issue one request per mode, and confirm one `lookalike_query` line per
    request with all fields populated and no profile prose in it.

- [ ] **Full gate before marking implemented**
  - Files: none
  - Do: Run the whole quality gate plus a warm-index latency spot check.
  - Verify: `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm security:boundaries`,
    `pnpm security:route-coverage`, `pnpm security:provider-metering`,
    `pnpm test:api-isolation:local`, `pnpm test:rls:local`, and `pnpm build`. (`pnpm ci:local`
    bundles the standard set — run it verbatim and do not substitute invented env values.) Then a
    p95 under 150 ms for `{"kind":"indexed",…}` measured over 20 sequential curls on an index of
    ≥ 500 embedded rows — with `EXPLAIN ANALYZE` on the emitted query confirming
    `Index Scan using builder_embeddings_hnsw_idx`, since the target is only meaningful if the
    index is genuinely in use. Below ~2k embedded rows the planner will legitimately pick a seq
    scan; either grow the corpus or run the EXPLAIN with `SET LOCAL enable_seqscan = off` and say
    which you did.
