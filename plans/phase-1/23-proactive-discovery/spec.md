# Proactive Discovery Worker (spec)

> **Status**: `implemented` — Phases 1-3 shipped and live-verified (see tasks.md for
> evidence). The "Future (not scheduled)" `discovery-keywords` AI task remains
> explicitly out of scope, pending an `ai-expansion` spec revision.
> **Depends on**: [`semantic-search`](../22-semantic-search/spec.md) (hard — this plan writes
> through its `builder_embeddings` upsert helper `src/lib/semantic/index-writer.ts`;
> schema + Phase 2 of that plan must exist first). No direct dependency on
> [`ai-expansion`](../21-ai-expansion/spec.md) — v1 makes zero LLM calls; embedding of the
> stubs this worker creates is drained by semantic-search's own worker.
> **Blocks**: nothing hard. Enhances [`semantic-search`](../22-semantic-search/spec.md)
> (cold-start fix — its spec already names this plan as the accelerator) and
> [`ai-sourcing-sprints`](../41-ai-sourcing-sprints/spec.md) reuses this worker's
> cell-cursor pattern.
> **Reality check**: This directory's original scope ("For you" dashboard
> recommendations) SHIPPED: `GET /api/recommendations`
> (`src/routes/api/recommendations/index.ts`) re-runs the user's saved queries, dedupes,
> excludes tracked builders via `getTrackedKeySet` (`src/shared/lib/tracked-builders.ts`),
> and `RecommendationsSection.tsx` renders it on the dashboard — do not re-plan it. What
> does NOT exist: any background discovery worker, `src/lib/discovery/`, or a populated
> global profile store (`builder_embeddings` is planned in semantic-search, not built).

## Problem

The semantic index (`builder_embeddings`, from semantic-search) only grows when users
search — a fresh deployment has an empty index, so every semantic query degrades to the
slow federated path, and `/explore`-style surfaces have nothing local to draw from. Nobody
is filling the global profile-snapshot store proactively.

## Goal

A background worker that walks a **curated, static keyword/topic matrix** across the
existing 12 connectors on a cron cadence, and writes every result through the
semantic-search upsert helper into the global `builder_embeddings` store. Pure
infrastructure: no UI, no per-user writes, no LLM calls in v1.

Honest value statement:

1. **Primary**: solves semantic-search cold start — the index warms up without waiting for
   organic user searches.
2. **Secondary**: keeps the global profile-snapshot store broad and fresh across topics no
   user has searched yet, which future consumers (`/explore` freshness, sprint result
   enrichment, timeline candidates) can read. These consumers are _not_ built here.

If semantic-search were cancelled, this plan has no reason to exist — that coupling is
deliberate and stated.

## Non-goals

- **No new connectors.** Only the live 12 (`src/lib/sources/`): github, hn, devto, reddit,
  lobsters, stackoverflow, npm, huggingface, gitlab, codeberg, hashnode (dormant — dead
  legacy API), sourcehut (token-gated). The matrix simply doesn't schedule dormant/gated
  sources without their env keys.
- **No writes to `builders`.** That table is per-user (`unique(userId, source, sourceId)`,
  `_meta/app-reality.md` constraint 2). The global store is `builder_embeddings`, keyed
  `unique(source, sourceId)` — this worker writes only through its upsert helper.
- **No parallel profile store.** One global store, owned by semantic-search.
- **No LLM in v1.** The keyword matrix is static config. An optional `discovery-keywords`
  AI task (matrix expansion) is a later phase.
- **No queue system.** Idempotent HTTP-cron worker, cloned from
  `src/routes/api/admin/alerts/run-worker.ts` (app-reality constraint 3).
- **No user-facing UI.** The shipped `/api/recommendations` "For you" section is untouched.

## Architecture

### 1. The matrix (`src/lib/discovery/matrix.ts` — pure, tested)

A static array of **cells**. A cell is one federated search unit:

```ts
export interface DiscoveryCell {
  key: string; // stable id, e.g. 'rust-async@code'
  keywords: string[]; // 1–3 keywords fed to searchBuilders
  sources: SourceName[]; // ≤ 4 sources per cell (per-source politeness)
}
export const DISCOVERY_MATRIX: DiscoveryCell[];
```

~40–60 cells built from a curated topic list (rust, go, react, ml/llm, devops, embedded,
security, data-eng, design-systems, indie/saas, …) × source groups (code forges:
github/gitlab/codeberg; community: hn/reddit/lobsters; content: devto/stackoverflow;
registries: npm/huggingface). Keys are stable so the cursor survives matrix edits
(unknown key → cursor resets to 0, logged). Cells referencing sources whose env keys are
unset still run — connectors already no-op or degrade gracefully on their own.

### 2. Cursor state (`discovery_state` table — durable, single row)

```ts
export const discoveryState = pgTable("discovery_state", {
  id: text("id").primaryKey(), // constant 'default'
  cursor: integer("cursor").notNull().default(0), // index into DISCOVERY_MATRIX
  lastCellKey: text("last_cell_key"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  stats: jsonb("stats")
    .$type<{ runs: number; upserted: number; errors: number }>()
    .notNull()
    .default({ runs: 0, upserted: 0, errors: 0 }),
});
```

Postgres, not Redis: Redis is optional in this stack (`src/shared/lib/redis.ts`) and the
cursor must survive restarts. One row, upserted.

### 3. Worker (`src/lib/discovery/worker.ts` + `POST /api/admin/discovery/run-worker`)

Endpoint clones the admin-auth pattern of `src/routes/api/admin/alerts/run-worker.ts`.
Hit by VPS cron **every 15 minutes** (same crontab as the alerts and embeddings workers).

Each run:

1. Load (or init) the cursor row.
2. Take the next `DISCOVERY_CELLS_PER_RUN` (env, default 2) cells, wrapping around.
3. For each cell **sequentially** (never parallel across cells — pacing): call
   `searchBuilders({ keywords, sources, perPage: 30 })` (`src/lib/search.ts`). Connectors
   swallow their own errors and the orchestrator uses `Promise.all` internally per cell —
   a dead source yields `[]`, never aborts the run.
4. Filter results to `kind === 'person'` (repos are noise in a people index) and pass them
   to `upsertEmbeddingStubs(results)` (`src/lib/semantic/index-writer.ts`, from
   semantic-search). `contentHash` inside the helper makes re-visits no-ops.
5. Advance and persist the cursor; accumulate stats; return
   `{ cellsRun: string[], resultsSeen, upserted, cursor, capped }`.

Idempotent: re-running the same cell only touches rows whose content actually changed.
Safe under accidental double-cron: worst case a cell runs twice, which the hash absorbs.

### Pacing & budget math (spelled out)

- 2 cells/run × 96 runs/day = **192 federated searches/day**, spread over 12 sources with
  ≤ 4 sources per cell → ≈ 64 requests/source/day ≈ 2.7/hour/source. Far below every
  source's public limits (GitHub authed 5k/h; Algolia HN, dev.to, etc. are generous).
- `searchBuilders`'s own 5-minute Redis/memory cache means a manual re-trigger is free.
- **Daily stub cap**: before upserting, the worker checks a Redis daily counter
  `discovery:stubs:{YYYY-MM-DD}` (in-memory fallback, same trade-off as `rate-limit.ts`)
  against `DISCOVERY_DAILY_STUB_CAP` (env, default 1500). When exceeded, the run still
  advances the cursor but skips upserts and reports `capped: true`. This keeps discovery
  inside semantic-search's stated embedding cost envelope (its spec budgets 200–2000
  docs/day; exact spend depends on the configured embedding model).
- A full matrix pass at defaults: ~50 cells / 2 per run ≈ 25 runs ≈ **6.25 hours** — the
  whole matrix refreshes ~4×/day, and unchanged profiles cost nothing after the first pass.

### Env additions (`src/shared/lib/env.ts`, all optional)

```ts
DISCOVERY_CELLS_PER_RUN: z.coerce.number().int().positive().default(2),
DISCOVERY_DAILY_STUB_CAP: z.coerce.number().int().positive().default(1500),
```

No kill-switch env needed: the worker only runs when cron calls it; removing the cron line
stops it. A `503` is returned when the `builder_embeddings` table doesn't exist yet
(semantic-search not migrated), so deploy order mistakes fail loudly and harmlessly.

## Later phase (optional, AI): `discovery-keywords`

Generate keyword expansions for matrix topics ("rust async" → "tokio", "io_uring", …).

- **Tier policy**: `server-only` (background, admin-triggered; policy rule 2).
- **Input**: `{ topics: string[] }` (≤ 20, operator-supplied — not untrusted).
- **Output**: `z.object({ expansions: z.record(z.string(), z.array(z.string().min(2)).max(6)) })`.
- **Cache TTL**: 30 days. **Allowances**: `{ free: 0, pro: 0, team: 0 }` — not a user task;
  invoked only by an admin endpoint that imports `minimaxChat` directly (like
  `/api/ai/embed`'s operator surface). **maxOutputTokens**: 512.
- **Fallback**: the static matrix — expansions are additive suggestions an admin reviews
  and commits into `matrix.ts`; the model never edits config directly.
- **Cost**: a handful of calls per quarter. Negligible.

## Success metrics

- After 48 h of cron: `SELECT count(*) FROM builder_embeddings` ≥ 2000 rows spanning ≥ 8
  sources (verifiable via the worker's stats).
- Semantic-search's "cold start" branch (`mode: 'hybrid'`) rate drops measurably once
  discovery has run for a week (its own metric; this plan feeds it).
- Second full matrix pass upserts < 10% of what the first did (contentHash working).

## Resolved edge cases

- **semantic-search not deployed yet**: run-worker returns
  `503 { error: 'embeddings_store_missing' }`; cron retries harmlessly.
- **Matrix edited, cursor out of range / unknown key**: cursor wraps to 0, one log line,
  no crash.
- **A source starts erroring** (rate-limited, dead API): its connector returns `[]`
  (existing behavior, e.g. hashnode's dead legacy API); the cell still upserts what other
  sources returned.
- **Redis absent**: daily cap falls back to a per-instance in-memory counter (best-effort,
  documented — same as `rate-limit.ts`); cursor is in Postgres so pacing survives.
- **Duplicate people across sources**: distinct `(source, sourceId)` rows by design —
  identical to organic write-through; query-time dedup is semantic-search's job.
