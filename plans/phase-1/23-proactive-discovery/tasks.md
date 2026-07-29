# Proactive Discovery Worker (tasks)

> **Status**: `implemented` — Phases 1-3 complete, verified via `pnpm type-check` /
> `pnpm test` (358/358) / `pnpm lint` (0 errors) and a live admin run against the dev DB
> (see notes below each phase).
> **Depends on**: [`semantic-search`](../22-semantic-search/spec.md) (hard — Phases 1–2:
> `builder_embeddings` schema + `src/lib/semantic/index-writer.ts#upsertEmbeddingStubs`)
> **Blocks**: nothing hard — see spec.md header
> **Reality check**: "For you" recommendations already shipped
> (`src/routes/api/recommendations/index.ts`, `RecommendationsSection.tsx`) — recorded
> below, not re-planned. Worker pattern to clone:
> `src/routes/api/admin/alerts/run-worker.ts`.

## Phase 0 — Delivered (record only)

- [x] **"For you" dashboard recommendations (old scope of this directory)**
  - Files: `src/routes/api/recommendations/index.ts`, `src/modules/dashboard/components/RecommendationsSection.tsx`

## Phase 1 — Matrix + state

- [x] **Discovery matrix module (pure)**
  - Files: `src/lib/discovery/matrix.ts`
  - Do: Export `DiscoveryCell { key, keywords, sources }`, `DISCOVERY_MATRIX` (~40–60
    curated cells; topics × source groups per spec §1; `SourceName` imported from
    `src/lib/sources/types.ts`), and `cellAt(cursor: number): DiscoveryCell` (wraps modulo
    length).
  - Verify: `pnpm type-check`. — Done: 60 cells (30 topics × source groups), clean.
- [x] **Matrix tests**
  - Files: `tests/unit/lib/discovery/matrix.test.ts`
  - Do: Unique keys; every cell: 1–3 keywords, 1–4 sources, all sources valid; matrix
    length ≥ 40; `cellAt(len)` === `cellAt(0)`.
  - Verify: `pnpm test matrix`. — Done: 6/6 passing.
- [x] **`discovery_state` table**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0014_ambitious_whiplash.sql`
  - Do: Single-row table per spec §2 (`id` pk, `cursor` int default 0, `lastCellKey`,
    `lastRunAt`, `stats` jsonb default `{runs:0,upserted:0,errors:0}`); `pnpm db:generate`
    - `pnpm db:migrate`.
  - Verify: `\d discovery_state` on a fresh DB. — Done: migration generated + applied to
    local DB; migration-hashes.json manifest regenerated (`--write`) and the hardcoded
    migration count in `migration-integrity.test.ts` bumped 14→15.
- [x] **Env vars**
  - Files: `src/shared/lib/env.ts`
  - Do: Add `DISCOVERY_CELLS_PER_RUN` (coerced int, default 2) and
    `DISCOVERY_DAILY_STUB_CAP` (coerced int, default 1500).
  - Verify: `pnpm type-check`; app boots with neither set. — Done.

## Phase 2 — Worker + endpoint

- [x] **Worker core**
  - Files: `src/lib/discovery/worker.ts`
  - Do: `runDiscoveryWorker()` per spec §3: load/init cursor row (`id = 'default'`); loop
    `DISCOVERY_CELLS_PER_RUN` cells **sequentially**; per cell
    `searchBuilders({ keywords, sources, perPage: 30 })` (`src/lib/search.ts`), filter
    `kind === 'person'`; check daily counter `discovery:stubs:{YYYY-MM-DD}` (Redis via
    `getRedis()`, in-memory `Map` fallback) against the cap — skip upserts when exceeded;
    else `upsertEmbeddingStubs(persons)` (`src/lib/semantic/index-writer.ts`) and `INCRBY`
    the counter; advance + persist cursor and stats; return
    `{ cellsRun, resultsSeen, upserted, cursor, capped }`. Export pure
    `isCapped(count, cap)` for tests. Unknown/out-of-range cursor → reset 0 + `log.warn`.
  - Verify: `pnpm test discovery` (pure parts); type-check. — Done.
  - **Deviation**: `upserted` is "profiles passed to `upsertEmbeddingStubs` this run", not
    "rows actually changed" — the helper returns `void` and dedups by `contentHash`
    internally with no count surfaced. Confirmed via live test that the DB-level upsert
    still dedups correctly (re-running the same two cells added ~12 net new rows instead
    of the full 82, i.e. most rows hit the `ON CONFLICT` no-op path) even though the
    worker's own `upserted` counter can't distinguish insert vs. no-op.
- [x] **Worker tests (pure parts)**
  - Files: `tests/unit/lib/discovery/worker.test.ts`
  - Do: `isCapped` boundary cases; cursor wrap/reset logic (extract as pure
    `nextCursor(cursor, step, len)`).
  - Verify: `pnpm test discovery`. — Done: 6/6 passing (12/12 combined with matrix.test.ts).
- [x] **Admin run-worker endpoint**
  - Files: `src/routes/api/admin/discovery/run-worker.ts`
  - Do: Clone the admin-auth + try/catch shape of
    `src/routes/api/admin/alerts/run-worker.ts`; POST runs `runDiscoveryWorker()`; when
    the `builder_embeddings` relation is missing (catch Postgres `42P01`), return
    `503 { error: 'embeddings_store_missing' }`. Doc-comment: VPS cron every 15 min, same
    crontab as alerts/embeddings workers.
  - Verify: As admin, `curl -X POST /api/admin/discovery/run-worker` twice → second run
    reports mostly-zero `upserted` for the same cells (hash no-op);
    `SELECT count(*) FROM builder_embeddings WHERE embedding IS NULL` grew after the first;
    non-admin gets 403. — Done via Playwright browser fetch as the local admin session:
    first run on `rust@code`/`rust@community` → `{ok:true, resultsSeen:82, upserted:82,
    cursor:2}`; `builder_embeddings` count 1446 → after resetting cursor to 0 and
    re-running the same two cells, count only grew to 1539 (~12 net new rows, not +82),
    confirming DB-level contentHash dedup works correctly even though the worker's
    `upserted` field doesn't reflect it directly (see deviation note above).

## Phase 3 — Operations polish

- [x] **Structured run log**
  - Files: `src/lib/discovery/worker.ts`
  - Do: `log.info('discovery_worker_run', report)` mirroring `alerts_worker_run`
    (`src/shared/lib/log.ts`).
  - Verify: log line visible on a manual run. — Done. (Report object is spread into a
    fresh literal — `log.info('discovery_worker_run', { ...report })` — because the
    declared `DiscoveryWorkerResult` type doesn't structurally satisfy `LogContext`'s
    string index signature, but a spread object literal does.)
- [x] **Admin visibility**
  - Files: `src/routes/api/admin/metrics/index.ts`, `src/routes/_dashboard/admin/metrics.tsx`,
    `src/shared/lib/repositories/discovery-state.ts` (new read-only accessor)
  - Do: Include `discovery_state` (cursor, lastCellKey, lastRunAt, stats) in the admin
    metrics payload and render a small card.
  - Verify: UI check as admin after ≥ 1 run. — Done: visually confirmed via Playwright at
    `/admin/metrics` — new "Proactive discovery" card renders Runs/Upserted/Errors and
    `cursor · lastCellKey`. **Bonus fix**: found and fixed a pre-existing crash unrelated
    to this plan — `MetricCard` typed its `value` prop as `number` but
    `db.totalSavedQueries/totalBuilders/totalNotes` are hardcoded `null` placeholders in
    the API response, so `value.toLocaleString()` threw and crashed the entire
    `/admin/metrics` page for every visitor. Fixed by widening the type to
    `number | null` and rendering `—` for null.

## Future (not scheduled)

- `discovery-keywords` AI task + admin suggestion endpoint requires a future spec revision
  after [`ai-expansion`](../21-ai-expansion/spec.md); expansions remain operator-reviewed and
  are never auto-committed.
