# Unified Builder Timeline (plan)

> **Status**: `pending`
> **Depends on**: nothing hard; [`ai-expansion`](../20-ai-expansion/spec.md) only for Phase 4
> **Blocks**: nothing — future consumers noted in spec.md header
> **Reality check**: No timeline code exists. Profile view to extend:
> `src/modules/builder-profile/components/BuilderProfilePage.tsx`. Cache/fetch conventions
> to mirror: `src/lib/search.ts` (two-layer cache), `src/lib/sources/*.ts` (fail-soft
> fetchers).

## Phases

### Phase 1 — Types, normalizer, first fetcher (github)

1. `src/lib/timeline/types.ts` (`TimelineEvent`, `TimelineResult`).
2. `src/lib/timeline/normalize.ts` + tests (sort/clamp/dedupe/cap/truncate — pure).
3. `src/lib/timeline/fetchers/github.ts` (events → TimelineEvent mapping) + a pure
   `mapGithubEvent(raw)` exported for tests with fixture payloads.

### Phase 2 — Service, cache, API, UI (ships the feature, github-only)

1. `src/lib/timeline/index.ts`: `getBuilderTimeline` with Redis 6 h TTL + in-memory
   fallback + 10 min negative cache; unsupported-source map.
2. `GET /api/builders/$builderId/timeline` (auth, ownership, rate limit, never-5xx).
3. `BuilderTimeline.tsx` + integration in `BuilderProfilePage.tsx` (lazy fetch, filter
   chips, three empty/degraded states).

Checkpoint: shippable — GitHub builders (the majority) get timelines; every other source
shows the honest "not available" note.

### Phase 3 — Remaining fetchers (each its own shippable checkpoint)

Order by value: `hn` (Algolia author search) → `devto` (articles by username) →
`stackoverflow` (answers by user id) → `gitlab` (events by user id). Each: fetcher +
pure mapping test + flip the source from unsupported to supported in the service map.

### Phase 4 — Optional AI summary (requires ai-expansion Phases 1–4)

1. Register `timeline-summary` in `src/shared/lib/ai/tasks.ts` (local-first; schema,
   TTL 6 h, allowances per spec).
2. "Summarize activity" button in `BuilderTimeline.tsx` via the `ai()` client; hides on
   `AIUnavailableError` / `serverAI: false` config.

### Future (not scheduled)

- Two-source join when devto metadata carries a `github` handle.
- Repo-kind rows (GitHub repo activity endpoint).
- Bluesky fetcher once [`bluesky-integration`](../16-bluesky-integration/spec.md) ships.
- Feeding smart-alerts real event detection from these fetchers.

## Risks

| Risk                                     | Likelihood | Impact | Mitigation                                                                                                          |
| ---------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| Upstream latency blocks profile UX       | Medium     | Medium | Lazy section fetch after profile paint; 5 s abort; skeleton state                                                   |
| GitHub unauthed 60 req/h ceiling         | Medium     | Medium | 6 h cache + 10 min negative cache; `GITHUB_TOKEN` already supported in env                                          |
| Event payload shape drift breaks mapping | Medium     | Low    | Pure mappers with fixture tests; unknown event types skipped, never thrown                                          |
| Cache stampede on popular builders       | Low        | Low    | Single-source fetch is cheap; acceptable duplicate fetch, noted for v2 (no coalescing, same stance as ai-expansion) |
| Endpoint abuse (activity scraping proxy) | Low        | Medium | Auth + ownership check + 30/min rate limit — only builders you track                                                |

## Rollback plan

- No schema, no migrations. Removing the `<BuilderTimeline />` render and the API route
  fully reverts the feature; Redis keys expire on their own.
- Phase 4 is covered by the AI platform kill switch
  (`AI_DISABLED_TASKS=timeline-summary`).
