# Semantic Search (tasks)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md) (global-public identity/index classification and tenant-private query isolation); [`ai-expansion`](../ai-expansion/spec.md) (Phases 1–3: `embeddings.ts`, `minimax.ts`, `tasks.ts`, `budget.ts` must exist). Enhanced by [`proactive-discovery`](../proactive-discovery/spec.md) (optional cold-start seeding).
> **Blocks**: [`proactive-discovery`](../proactive-discovery/tasks.md) (hard)
> **Reality check**: Extends `src/lib/search.ts`, `src/routes/api/search/builders.ts`, `src/modules/search/components/SearchPage.tsx` / `PersonResultCard.tsx`, `docker-compose.yml`. New global table only; `builders` schema untouched.

Ordered so the app ships cleanly after every checkbox.

## Phase 1 — pgvector + schema

- [ ] **Preflight the embedding deployment contract**
  - Files: `src/shared/lib/ai/embeddings.test.ts`, `.env.example`
  - Do: Configure `AI_EMBEDDING_URL`, `AI_EMBEDDING_MODEL`, optional
    `AI_EMBEDDING_API_KEY`, and `AI_EMBEDDING_DIM`; call `embedTexts(['dimension probe'])`
    against the intended staging provider and refuse migration if the returned vector length
    differs. Document names/placeholders only in `.env.example`, never values.
  - Verify: staging probe returns one finite vector of exactly `AI_EMBEDDING_DIM`; invalid
    dimension fails with `AIDimensionMismatchError` before any pgvector DDL runs.

- [ ] **Switch local Postgres to a pgvector image**
  - Files: `docker-compose.yml`
  - Do: Change the `db` service image `postgres:16-alpine` → `pgvector/pgvector:pg16`
    (same major; existing `builderhunt_postgres_data` volume remains compatible).
  - Verify: `pnpm db:up` then
    `docker exec builderhunt-db psql -U postgres -d builderhunt -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';"`
    prints a version.

- [ ] **Document the production (Coolify) pgvector step**
  - Files: `plans/semantic-search/plan.md` (Risks already cover it), `README.md` (deploy notes section)
  - Do: Add a short deploy note: the Coolify Postgres resource must run
    `pgvector/pgvector:pg16` (or have the extension installed) before this feature's
    migration is applied in prod; take a DB backup before the image swap.
  - Verify: Note present; no code change.

- [ ] **Single-source the embedding dimension**
  - Files: `src/shared/lib/ai/embedding-dim.ts`
  - Do: `export const EMBEDDING_DIM = env.AI_EMBEDDING_DIM` (import from
    `~/shared/lib/env`). This is the only place schema/queries read the dim from.
  - Verify: `pnpm type-check`.

- [ ] **Add the global builder_embeddings table**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `builderEmbeddings` exactly per spec.md §2 (`vector('embedding',
{ dimensions: EMBEDDING_DIM })` from `drizzle-orm/pg-core`, `unique(source, source_id)`,
    pending index on `embedded_at`, `profile` jsonb, `document`, `content_hash`). No changes
    to `builders`.
  - Verify: `pnpm type-check`.

- [ ] **Generate the migration and append pgvector DDL**
  - Files: `drizzle/` (new migration from `pnpm db:generate`)
  - Do: Run `pnpm db:generate`; prepend `CREATE EXTENSION IF NOT EXISTS vector;` and append
    `CREATE INDEX "builder_embeddings_hnsw_idx" ON "builder_embeddings" USING hnsw ("embedding" vector_cosine_ops);`
    to the generated SQL file (drizzle-kit emits neither).
  - Verify: `pnpm db:migrate` succeeds on a fresh DB;
    `\d builder_embeddings` shows the hnsw index and the configured vector dimension.

## Phase 2 — Document lib + write-through

- [ ] **Build the embedding-document module (pure)**
  - Files: `src/lib/semantic/embedding-doc.ts`
  - Do: Export `embeddedProfileSchema` (zod: username, displayName?, avatarUrl?, bio?,
    profileUrl, followersCount?, language?, country?, topics — public fields only),
    `buildEmbeddingDoc(profile)` (canonical template per spec.md §3, empty fields omitted,
    6000-char truncation), `contentHashOf(doc)` (sha256 hex via node `crypto`), and
    `toEmbeddedProfile(raw: RawBuilder)`.
  - Verify: `pnpm type-check`.

- [ ] **Test the document module**
  - Files: `src/lib/semantic/embedding-doc.test.ts`
  - Do: Same profile → same doc/hash; bio change → different hash; missing optional fields
    omit their lines; >6000-char bio truncates; `toEmbeddedProfile` strips unknown/private
    fields.
  - Verify: `pnpm test embedding-doc`.

- [ ] **Add the upsert helper and wire write-through**
  - Files: `src/lib/semantic/index-writer.ts`, `src/routes/api/search/builders.ts`, `src/routes/api/builders/track.ts`
  - Do: `upsertEmbeddingStubs(results: RawBuilder[])` — per row compute doc+hash, then
    `INSERT ... ON CONFLICT (source, source_id) DO UPDATE SET document, profile,
content_hash, embedding = NULL, embedded_at = NULL, updated_at = now()` **only** where
    `builder_embeddings.content_hash IS DISTINCT FROM excluded.content_hash`. Call it
    fire-and-forget (`void ...().catch(err => console.error(...))`) after successful search
    in `/api/search/builders` and after track in `/api/builders/track`.
  - Verify: Run a dashboard search; `SELECT count(*) FROM builder_embeddings WHERE embedding IS NULL`
    grows; repeating the identical search does not bump `updated_at`.

## Phase 3 — Worker

- [ ] **Add the embeddings run-worker endpoint**
  - Files: `src/routes/api/admin/embeddings/run-worker.ts`, `src/lib/semantic/embed-worker.ts`
  - Do: Endpoint clones the admin-auth pattern of
    `src/routes/api/admin/alerts/run-worker.ts`; `runEmbeddingWorker()` selects up to 256
    rows `WHERE embedding IS NULL ORDER BY created_at`, calls `embedTexts` in batches of
    ≤ 64 documents, updates `embedding`/`embedded_at` per row, counts failures without
    aborting the run; returns `{ pending, embedded, failed }`. Skip with 503 when
    `MINIMAX_API_KEY` unset or `AI_DISABLED=true`. Include the cron doc-comment (every
    5–15 min, same crontab as the alerts worker).
  - Verify: With a real key: authed `curl -X POST /api/admin/embeddings/run-worker` returns
    `embedded > 0`; second immediate call returns `pending: 0`; rerun is a no-op (idempotent).

## Phase 4 — Query path

- [ ] **Register the query-translate AI task**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: Add `query-translate`: tier `local-first`; input `z.object({ query:
z.string().min(3).max(300) })`; output `QueryTranslation` zod schema per spec.md §6
    (keywords 1–8, optional language/country, optional `sources` enum from
    `SOURCE_NAMES` in `src/lib/sources/types.ts`); `cacheTtlSeconds: 86400`; allowances
    `{ free: 0, pro: 200, team: 500 }`; `maxOutputTokens: 256`; system prompt per spec
    (JSON only, never invent filters). Extend the registry test to cover it.
  - Verify: `pnpm test tasks.test`.

- [ ] **Implement the semantic query engine**
  - Files: `src/lib/semantic/semantic-search.ts`
  - Do: `semanticSearch({ query, translated?, language?, country?, perPage })`:
    (1) embed query via `embedTexts([query])` with a 24 h Redis cache
    (`ai:cache:query-embed:${sha256(query)}`); (2) raw-SQL HNSW query per spec.md §5
    (`sql` template, `1 - (embedding <=> $vec) AS similarity`, LIMIT 50, keep ≥ 0.60,
    post-filter language/country); (3) if kept < `SEMANTIC_MIN_LOCAL_MATCHES` (10), obtain
    `QueryTranslation` (use `translated` param if provided, else run the task server-side
    via `minimaxChat` with the registry definition) and call the existing
    `searchBuilders()`; merge local-first deduped by `source:sourceId`, fire
    `upsertEmbeddingStubs` on the federated results; (4) return
    `{ results, mode: 'semantic' | 'hybrid', translated? }`. Export
    `SEMANTIC_MIN_LOCAL_MATCHES` and `SEMANTIC_SIMILARITY_THRESHOLD` constants.
  - Verify: `pnpm type-check`; with ≥ a few embedded rows, a related natural-language query
    returns them with `similarity` ≥ 0.60 (manual node/tsx script or endpoint in next task).

- [ ] **Add POST /api/search/semantic**
  - Files: `src/routes/api/search/semantic.ts`
  - Do: Auth required (401); plan gate via `getUserPlan` — pro/team else
    `403 { error: 'plan' }`; `rateLimit('search-semantic', userId, 20, 60)`; zod body
    `{ query, translated?, sources?, language?, country?, page?, perPage? }` (re-validate
    `translated` with the task output schema); call `semanticSearch`; annotate results with
    tracked state exactly as `src/routes/api/search/builders.ts` does
    (`getTrackedBuilderIds` + `trackedKey`); wrap everything so any AI/extension failure
    degrades to `searchBuilders({ keywords: query.split(/\s+/).filter(Boolean) })` with
    `mode: 'keyword-fallback'`.
  - Verify: Authed pro-user curl returns `mode: 'hybrid'` on a cold index with federated
    results present; free user gets 403; with `MINIMAX_API_KEY` unset returns
    `mode: 'keyword-fallback'` and still has results.

## Phase 5 — UI + gating

- [ ] **Add the Semantic toggle to the search page**
  - Files: `src/modules/search/components/SearchPage.tsx`
  - Do: Toggle beside the search input bound to URL state (`?mode=semantic`). Free users:
    toggle renders locked with a "Pro" pill linking to `/pricing` (plan available from the
    existing dashboard session/plan context; otherwise fetch `/api/me/plan-changes`-adjacent
    plan endpoint used by settings). When on, submit to `/api/search/semantic` with the raw
    query string; when Chrome AI prompt capability is `available`, run
    `ai('query-translate', { query })` client-side first and pass `translated` in the body.
    Hide the toggle when `/api/ai/config` reports `disabled` or `serverAI: false`
    (use `useAICapabilities`).
  - Verify: Pro user toggles semantic and gets results with the mode notice on a cold index;
    free user sees the locked pill; Firefox works via server translation.

- [ ] **Show similarity badges and hybrid notice**
  - Files: `src/modules/search/components/PersonResultCard.tsx`, `src/modules/search/components/SearchPage.tsx`
  - Do: When a result has `similarity`, render a `NN% match` badge in place of the score
    chip. When response `mode` is `hybrid` or `keyword-fallback`, render a one-line notice
    above results ("Not enough indexed matches yet — showing live search results too" /
    "Semantic search unavailable — showing keyword results").
  - Verify: Badges render for local hits; notice shows in hybrid mode; keyword mode
    (toggle off) is pixel-identical to today.

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm test && pnpm type-check && pnpm lint`; e2e manual: cold index → hybrid; run
    worker → warm queries go `mode: 'semantic'` under 100 ms (check server log timing);
    `AI_DISABLED=true` hides the toggle and `/api/search/semantic` degrades.
  - Verify: All green; degradation matrix behaves per spec.
