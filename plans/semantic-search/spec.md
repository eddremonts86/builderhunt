# Semantic Search (spec)

> **Status**: `complete`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/spec.md) (global-public identity/index classification and tenant-private query isolation); [`ai-expansion`](../ai-expansion/spec.md) (AI Platform — embedding adapter, `query-translate` task, budgets). Enhanced by [`proactive-discovery`](../proactive-discovery/spec.md) (populates baseline embeddings; semantic search must work without it).
> **Blocks**: [`proactive-discovery`](../proactive-discovery/spec.md) (hard — its worker writes through this plan's global index helper)
> **Reality check**: Federated keyword search exists (`src/lib/search.ts`, 12 sources, Redis+memory cached, `POST /api/search/builders`). `builders` is a **per-user** tracked cache (`unique(userId, source, sourceId)` in `src/shared/lib/db/schema.ts`) — NOT a global index. No pgvector, no embeddings, no AI code. "Semantic search" is already promised under Pro in `PLAN_PRICING` (`src/shared/lib/billing-shared.ts`).

## Problem

Keyword search misses synonym matches ("frontend developer" vs "UI engineer building React
apps"), cannot handle natural-language intent queries, and every query pays external-API
latency and rate limits. There is no local index to search at all.

## Goal

Natural-language search over a **global** local vector index that grows organically:

1. Embed profiles once per unique external profile (configured embeddings, pgvector + HNSW).
2. Answer semantic queries from Postgres in <100 ms when the index has matches.
3. Degrade gracefully to today's federated keyword search (via AI query translation) when
   local matches are insufficient — including on a cold, empty index.

## Non-goals

- No embedding of arbitrary external content — only profiles that flow through BuilderHunt
  (search results, tracked builders, discovery worker output).
- No feature-specific embedding clients. Every vector goes through the AI platform's one
  configured adapter so a deployment uses one model and one vector space.
- No queue system. Embedding computation uses the idempotent HTTP-cron worker pattern.
- No replacement of keyword search — semantic mode is an additive, Pro-gated toggle.

## User stories

1. As a **pro user**, I toggle "Semantic" on the search bar, type "senior web dev with design
   taste", and get relevant profiles even when bios don't contain those words, each with a
   `% match` badge.
2. As a **pro user on a fresh workspace** (empty index), the same query still returns results:
   the query is translated to keywords/filters and federated search runs — and those results
   seed the index for next time.
3. As a **free user**, the Semantic toggle shows an upgrade hint (feature listed under Pro).

## The per-user vs global tension — RESOLVED

`builders` rows are per-user: the same GitHub profile tracked by 3 users is 3 rows.
Embedding per row would triple vector spend and fragment the index. **Decision: a global
`builder_embeddings` table, one row per unique `(source, sourceId)`, shared across all
users.** Content is public profile data only, so sharing is privacy-safe. `contentHash`
makes re-embedding idempotent: unchanged profiles are never re-sent to MiniMax.

Search results from the global index are re-annotated per requesting user (tracked state via
`getTrackedBuilderIds`, same as `POST /api/search/builders` does today).

## Architecture

### 1. Infrastructure: pgvector

- **Local dev**: change `docker-compose.yml` `db` image `postgres:16-alpine` →
  `pgvector/pgvector:pg16` (same Postgres major; existing volume data is compatible).
- **Production (Coolify Postgres on Hetzner)**: the managed Postgres container must also run
  a pgvector-enabled image. Operator step, documented in tasks: switch the Coolify database
  resource image to `pgvector/pgvector:pg16` (data volume survives; verify with a backup
  first), then the migration's `CREATE EXTENSION IF NOT EXISTS vector;` succeeds.
- The app fails soft: if the extension is missing, `/api/search/semantic` returns
  `503 { error: 'semantic_unavailable' }` and the UI falls back to keyword mode.

### 2. Schema (Drizzle migration)

```ts
// src/shared/lib/db/schema.ts — drizzle-orm ≥ 0.45 has a built-in vector type
import { vector } from "drizzle-orm/pg-core";
import { EMBEDDING_DIM } from "~/shared/lib/ai/embedding-dim"; // re-exports env.AI_EMBEDDING_DIM (default 1536)

export const builderEmbeddings = pgTable(
  "builder_embeddings",
  {
    id: text("id").primaryKey(), // randomId()
    source: text("source").notNull(), // SourceName from src/lib/sources/types.ts
    sourceId: text("source_id").notNull(),
    contentHash: text("content_hash").notNull(), // sha256 of the embedding document
    document: text("document").notNull(), // the exact text that was embedded
    profile: jsonb("profile").$type<EmbeddedProfile>().notNull(), // display payload (below)
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }), // NULL = pending
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sourceUnique: unique("builder_embeddings_source_unique").on(
      t.source,
      t.sourceId,
    ),
    pendingIdx: index("builder_embeddings_pending_idx").on(t.embeddedAt), // worker scan
  }),
);
```

HNSW index added as hand-written SQL appended to the generated migration (drizzle-kit does
not emit it): `CREATE INDEX builder_embeddings_hnsw_idx ON builder_embeddings USING hnsw
(embedding vector_cosine_ops);` plus `CREATE EXTENSION IF NOT EXISTS vector;` at the top.
**The dimension appears exactly once in code** (`EMBEDDING_DIM` from `env.AI_EMBEDDING_DIM`);
the migration's literal `vector(1536)` is generated from it. Changing the dim later requires
a re-embed migration (documented, out of scope).

`EmbeddedProfile` (zod-typed in `embedding-doc.ts`): `{ username, displayName?, avatarUrl?,
bio?, profileUrl, followersCount?, language?, country?, topics }` — the minimal payload
needed to render `PersonResultCard` from a local hit without refetching the source. Public
data only; no userId anywhere in this table.

### 3. Embedding document + contentHash (pure, tested)

`src/lib/semantic/embedding-doc.ts`:

- `buildEmbeddingDoc(profile: RawBuilder-like): string` — canonical template:
  `"Name: {displayName} (@{username})\nSource: {source}\nBio: {bio}\nLanguage: {language}\nCountry: {country}\nTopics: {topics.join(', ')}\nFollowers: {followersCount}"`,
  fields omitted when empty, truncated to 6000 chars.
- `contentHashOf(doc): string` — sha256 hex. Same profile content ⇒ same hash ⇒ no re-embed.

### 4. Write-through indexing (no AI call in the request path)

- `POST /api/search/builders` (and the track endpoint) upsert into `builder_embeddings`:
  for each result, compute doc + hash; `INSERT ... ON CONFLICT (source, source_id) DO UPDATE`
  only when `content_hash` changed, setting `embedding = NULL, embedded_at = NULL` to mark
  re-embed. Fire-and-forget (`.catch(log)`) — search latency unaffected.
- **Worker** `POST /api/admin/embeddings/run-worker` (admin-auth, same pattern as
  `src/routes/api/admin/alerts/run-worker.ts`, hit by VPS cron every 5–15 min): selects up to
  256 rows `WHERE embedding IS NULL`, batches ≤ 64 docs to `embedTexts`
  (`src/shared/lib/ai/embeddings.ts`), updates rows. Idempotent, safe to run concurrently-ish
  (last write wins on identical content), returns `{ pending, embedded, failed }`.
- `proactive-discovery` (separate plan) feeds the same upsert helper — that is the whole
  cold-start enhancement; no other coupling.

### 5. Query flow (`POST /api/search/semantic`)

Body `{ query: string (3–300 chars), sources?, language?, country?, page?, perPage? }`.

1. Auth required; plan gate: `getUserPlan` ∈ {pro, team} else `403 { error: 'plan' }`.
2. Rate limit `('search-semantic', userId, 20, 60)`.
3. Embed the raw query via `embedTexts([query])` (server-side; Redis-cached by the AI
   platform's cache keyed on the query text, TTL 24 h).
4. pgvector search:
   `SELECT *, 1 - (embedding <=> $vec) AS similarity FROM builder_embeddings
WHERE embedding IS NOT NULL ORDER BY embedding <=> $vec LIMIT 50`,
   keep rows with `similarity ≥ 0.60`, apply language/country post-filters.
5. **Degradation check**: if kept rows `< 10` (`SEMANTIC_MIN_LOCAL_MATCHES`), run the
   `query-translate` AI task server-side (see §6) and execute `searchBuilders()` (existing
   federated path) with the translated keywords/filters; merge (local hits first, dedupe by
   `source:sourceId`), and write-through the new results (§4).
6. Annotate tracked state per user (`getTrackedBuilderIds` + `trackedKey`, as in
   `src/routes/api/search/builders.ts`); return
   `{ builders: [{ ...profile, similarity?, tracked, trackedRowId }], mode: 'semantic' | 'hybrid', translated?: QueryTranslation }`.
7. Any AI failure (embed error, translate error, missing extension) → fall back to plain
   keyword `searchBuilders(query.split(/\s+/))` with `mode: 'keyword-fallback'` — never a
   dead end. Cold start is just the `< 10` branch with zero local rows.

### 6. AI task: `query-translate` (registered in `src/shared/lib/ai/tasks.ts`)

- **Tier**: `local-first` (Chrome AI Prompt API; MiniMax via `/api/ai/complete` as fallback,
  per policy — interactive + ephemeral + this-user-only). The search UI runs it client-side
  when available and passes the translation to the server (`translated` request field) to
  skip step 5's server-side call; the server re-validates with the same zod schema.
- **Input schema**: `{ query: string }` (the user's raw text is the user's own input — not
  wrapped as untrusted).
- **Output schema** (`QueryTranslation`):
  `z.object({ keywords: z.array(z.string().min(1)).min(1).max(8), language: z.string().optional(), country: z.string().optional(), sources: z.array(z.enum(SOURCE_NAMES)).optional() })`
  — `SOURCE_NAMES` imported from `src/lib/sources/types.ts`.
- **Cache TTL**: 24 h. **Allowances**: `{ free: 0, pro: 200, team: 500 }` (free is gated —
  Pro feature). **maxOutputTokens**: 256.
- System prompt: translate a natural-language sourcing query into search keywords and
  optional filters; keywords are technologies/domain nouns; never invent filters not implied
  by the query; JSON only.

## UX integration

- `SearchPage.tsx` (`src/modules/search/components/`): a "Semantic" toggle beside the search
  input. Off = today's behavior, untouched. On (pro/team) = calls `/api/search/semantic`;
  free users see the toggle with a lock + "Pro" pill linking to `/pricing`.
- `PersonResultCard.tsx`: when `similarity` is present, show a `{Math.round(similarity*100)}%
match` badge in place of the score chip; `mode: 'hybrid' | 'keyword-fallback'` renders a
  one-line notice ("Not enough indexed matches yet — showing live search results too").
- Hidden entirely when `/api/ai/config` reports `disabled` or `serverAI: false`.

## Cost model (per ai-policy)

- Embeddings: write-through only embeds _new/changed_ profiles — steady state ≈ 200–2000
  docs/day; exact token/cost accounting comes from the configured vector provider and
  `contentHash` prevents repeats.
- Query embeds: 1 per unique semantic query per 24 h (Redis cache); est. ≤ 50/user/day cap
  via task budget. Query translation: ≥ 70% expected on Chrome AI (Tier 1, free); MiniMax
  absorbs the rest at ~300 tokens/call. All server spend is Pro/Team-gated.

## Success metrics

- Warm-index semantic query p95 < 100 ms (local HNSW) vs ~1.5 s federated.
  Note on how to read this once measured: an indexable `ORDER BY` makes the HNSW
  index *available*, not mandatory — the planner still costs it against a seq
  scan, and below roughly 2k embedded rows the seq scan legitimately wins and is
  still well inside 100 ms. So this metric can be met without HNSW being used at
  all on a small corpus; verify the *mechanism* with `EXPLAIN` (look for
  `Index Scan using builder_embeddings_hnsw_idx`) rather than inferring it from
  the latency number. Measured locally at `LIMIT 50`: 352 embedded rows → seq
  scan at ~7 ms; 2k/5k/20k rows → HNSW index scan.
- ≥ 60% of semantic queries answered fully locally after 2 weeks of organic use.
- Zero-result semantic queries < 2% (degradation ladder catches the rest).

## Resolved edge cases

- **Cold start / empty index**: step 5 always produces federated results; the notice explains
  hybrid mode. `proactive-discovery` accelerates warm-up but is not required.
- **pgvector missing in prod**: 503 → UI auto-falls-back to keyword mode + logged warning.
- **Dim mismatch** (`AI_EMBEDDING_DIM` changed): `embedTexts` throws
  `AIDimensionMismatchError`; worker marks batch failed and surfaces count — no corrupt rows.
- **Profile disappears upstream**: embeddings persist (public snapshot); a stale profile is
  acceptable — rows older than 180 days without re-touch may be pruned by the worker (soft
  TTL, config constant).
- **Same profile, different bios per source**: distinct `(source, sourceId)` rows by design;
  dedup at query time reuses `deduplicateBuilders` semantics on the merged result.
