# Semantic Search (plan)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/plan.md) (global-public identity/index classification and tenant-private query isolation); [`ai-expansion`](../ai-expansion/spec.md) (must be implemented through Phase 3 — `embedTexts`, task registry, budgets). Enhanced by [`proactive-discovery`](../proactive-discovery/spec.md) (cold-start seeding; not required).
> **Blocks**: [`proactive-discovery`](../proactive-discovery/spec.md) (hard)
> **Reality check**: Builds on `src/lib/search.ts` (federated search), `src/routes/api/search/builders.ts` (annotation pattern), `src/shared/lib/tracked-builders.ts`, `docker-compose.yml` (postgres:16-alpine today). `builders` stays untouched — the new global `builder_embeddings` table carries all vector state.

## Phases (dependency order — shippable after each)

### Phase 1 — pgvector infrastructure + schema

Preflight the configured embedding endpoint/model and assert its real vector dimension.
Then swap the compose `db` image to `pgvector/pgvector:pg16`; add `EMBEDDING_DIM` re-export;
add `builder_embeddings` to `schema.ts`; generate the migration and append
`CREATE EXTENSION IF NOT EXISTS vector;` + the HNSW index SQL. Document the Coolify
production image swap. App behavior unchanged (dead table).

### Phase 2 — Pure document/hash lib + write-through upserts

`embedding-doc.ts` (doc builder, contentHash, `EmbeddedProfile` zod schema) with tests;
`upsertEmbeddingStubs(results)` helper wired fire-and-forget into
`/api/search/builders` and `/api/builders/track`. Rows accumulate with `embedding = NULL`;
still no user-visible change.

### Phase 3 — Embedding worker

`POST /api/admin/embeddings/run-worker`: batch-embeds pending rows via `embedTexts`,
idempotent, returns counts. VPS cron note added alongside the alerts-worker cron. The
index now fills; still no UI.

### Phase 4 — Query path

Register `query-translate` in `src/shared/lib/ai/tasks.ts`; implement
`src/lib/semantic/semantic-search.ts` (query embed → HNSW query → threshold →
federated merge fallback) and `POST /api/search/semantic` (auth, pro/team gate, rate
limit, tracked annotation, `mode` field, keyword-fallback catch-all).

### Phase 5 — UI + gating polish

Semantic toggle in `SearchPage.tsx` (locked + Pro pill for free tier, hidden when AI
disabled), `% match` badge and hybrid-mode notice in `PersonResultCard.tsx`.

## Risks

| Risk                                                  | Likelihood   | Impact | Mitigation                                                                                                                          |
| ----------------------------------------------------- | ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Coolify prod Postgres image swap loses data           | Low          | High   | Backup before swap; pgvector image is stock Postgres + extension, same major version; verify with `SELECT 1` + row counts post-swap |
| Embedding spend grows with search volume              | Medium       | Medium | contentHash idempotency, worker batch cap (256/run), 24 h query-embed cache, soft prune of stale rows                               |
| Local matches are semantically poor at low index size | High (early) | Low    | `SEMANTIC_MIN_LOCAL_MATCHES=10` forces hybrid mode until the index is genuinely useful                                              |
| drizzle-kit doesn't emit HNSW/extension DDL           | Certain      | Low    | Hand-append SQL to the generated migration file (documented task)                                                                   |
| `AI_EMBEDDING_DIM` changed after data exists          | Low          | High   | Dim asserted at embed time; changing it requires an explicit re-embed migration (called out, out of scope)                          |

## Rollback

- Phases 1–3 are invisible to users: stop the cron, drop `builder_embeddings` (single
  additive table; `builders` untouched), revert the compose image if desired.
- Phase 4–5: remove the toggle / route; or leave code and gate off by removing
  `query-translate` allowances (set all tiers to 0) / `AI_DISABLED_TASKS=query-translate` —
  UI hides, keyword search is unaffected. The kill ladder from `ai-expansion` applies.
