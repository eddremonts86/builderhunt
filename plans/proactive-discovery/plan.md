# Proactive Discovery Worker (plan)

> **Status**: `implemented` — Phases 1-3 shipped, tested (`pnpm test` 358/358, `pnpm lint`
> 0 errors), and live-verified against the dev DB via Playwright (see tasks.md).
> **Depends on**: [`semantic-search`](../semantic-search/spec.md) (hard — needs
> `builder_embeddings` + `upsertEmbeddingStubs` from its Phases 1–2)
> **Blocks**: nothing hard — enhances semantic-search cold start;
> [`ai-sourcing-sprints`](../ai-sourcing-sprints/spec.md) reuses the cell-cursor worker pattern
> **Reality check**: The old "For you" scope of this directory shipped as
> `GET /api/recommendations` + `RecommendationsSection.tsx` — recorded, not re-planned.
> No `src/lib/discovery/` code exists. The worker pattern to clone is
> `src/routes/api/admin/alerts/run-worker.ts`.

## Phases

### Phase 0 — Delivered by earlier work (record only)

"For you" recommendations: `src/routes/api/recommendations/index.ts`,
`src/modules/dashboard/components/RecommendationsSection.tsx`. Live re-search over the
user's saved queries; no background component. Untouched by this plan.

### Phase 1 — Matrix + cursor state (pure foundation, no behavior change)

1. `src/lib/discovery/matrix.ts`: `DiscoveryCell` type + `DISCOVERY_MATRIX` (~40–60 cells)
   - `cellAt(cursor)` wrap-around accessor. Vitest: unique keys, every cell has 1–3
     keywords and 1–4 valid `SourceName`s, matrix non-empty.
2. Migration: `discovery_state` single-row table.
3. Env: `DISCOVERY_CELLS_PER_RUN`, `DISCOVERY_DAILY_STUB_CAP`.

### Phase 2 — Worker + endpoint (the feature)

1. `src/lib/discovery/worker.ts`: `runDiscoveryWorker()` per spec §3 — sequential cells,
   person-kind filter, daily-cap check, write-through `upsertEmbeddingStubs`, cursor
   persist, stats. Pure helpers (`isCapped(count, cap)`, cursor advance) exported + tested.
2. `POST /api/admin/discovery/run-worker`: admin-gated clone of the alerts run-worker;
   503 when `builder_embeddings` is missing; returns the run report JSON.
3. Cron doc-comment in the endpoint (every 15 min, same crontab as alerts/embeddings
   workers) + operator note in the repo's deploy docs if present.

Checkpoint: shippable — index warms autonomously; nothing user-facing changed.

### Phase 3 — Operations polish

1. Stats surfaced in the admin metrics page (`src/routes/_dashboard/admin/metrics.tsx`
   pattern): last run, cursor position, upserted today, capped days.
2. Structured log line `discovery_worker_run` via `src/shared/lib/log.ts` (mirrors
   `alerts_worker_run`).

### Future — optional AI matrix expansion

`discovery-keywords` task (spec'd in spec.md) + a small admin endpoint that returns
suggested expansions for operator review. Requires ai-expansion. Not scheduled.

## Risks

| Risk                                                    | Likelihood | Impact | Mitigation                                                                                                                                               |
| ------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedding spend balloons from broad matrix              | Medium     | Medium | `DISCOVERY_DAILY_STUB_CAP` (default 1500) + contentHash no-ops on unchanged profiles                                                                     |
| Source rate limits (GitHub unauthed = 60/h)             | Medium     | Low    | ≤ 4 sources/cell, 2 cells/run, sequential; `GITHUB_TOKEN` recommended in ops notes; connectors already fail-soft to `[]`                                 |
| Junk/low-quality profiles pollute the semantic index    | Medium     | Medium | Person-kind filter; curated matrix (no generic terms like "developer"); semantic-search's similarity threshold (0.60) filters weak matches at query time |
| Deploy-order mistake (discovery before semantic-search) | Low        | Low    | Explicit 503 `embeddings_store_missing`; cron retry is harmless                                                                                          |
| Matrix drift (stale topics)                             | High       | Low    | Stable cell keys + quarterly curation note; Future AI expansion phase                                                                                    |

## Rollback plan

- Remove the cron line → worker never runs. Endpoint idle is a no-op.
- `discovery_state` and any upserted `builder_embeddings` rows are inert data; semantic
  search treats them like organic rows. No migration rollback needed to disable.
- Full removal: drop the cron entry, delete `src/lib/discovery/` + the endpoint; the
  `discovery_state` table can be dropped in a later cleanup migration.
