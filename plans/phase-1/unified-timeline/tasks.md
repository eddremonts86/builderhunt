# Unified Builder Timeline (tasks)

> **Status**: `pending`
> **Depends on**: nothing hard; Phase 4 depends on [`ai-expansion`](../ai-expansion/spec.md)
> **Blocks**: nothing — see spec.md header
> **Reality check**: Zero timeline code exists. Extend
> `src/modules/builder-profile/components/BuilderProfilePage.tsx`; mirror fail-soft fetcher
> style from `src/lib/sources/*.ts` and the two-layer cache from `src/lib/search.ts`.

## Phase 1 — Types, normalizer, github fetcher

- [ ] **Event types**
  - Files: `src/lib/timeline/types.ts`
  - Do: `TimelineEventType`, `TimelineEvent`, `TimelineResult` exactly per spec §1
    (`SourceName` from `src/lib/sources/types.ts`).
  - Verify: `pnpm type-check`.
- [ ] **Normalizer (pure) + tests**
  - Files: `src/lib/timeline/normalize.ts`, `src/lib/timeline/normalize.test.ts`
  - Do: `normalizeEvents(events)` — sort desc, drop future / >365-day-old timestamps,
    dedupe by `id`, cap 30, truncate `description` to 280 chars.
  - Verify: `pnpm test normalize` covering each rule.
- [ ] **GitHub fetcher**
  - Files: `src/lib/timeline/fetchers/github.ts`, `src/lib/timeline/fetchers/github.test.ts`
  - Do: `fetchGithubEvents({ username })` → GET
    `https://api.github.com/users/{username}/events/public` with `User-Agent`, optional
    `Authorization` from `env.GITHUB_TOKEN`, `AbortSignal.timeout(5000)`, try/catch → `[]`.
    Export pure `mapGithubEvent(raw): TimelineEvent | null` handling PushEvent,
    CreateEvent(repository), ReleaseEvent, PullRequestEvent(opened); unknown → null.
    If `username` contains `/` (repo-kind row) return `[]`.
  - Verify: `pnpm test github` with fixture payloads for the four event types + an unknown
    type.

## Phase 2 — Service, API, UI (ships github-only)

- [ ] **Timeline service with two-layer cache**
  - Files: `src/lib/timeline/index.ts`
  - Do: `getBuilderTimeline({ source, sourceId, username }): Promise<TimelineResult>` —
    supported-source map (`github` only for now, others `{ supported: false }`); Redis key
    `timeline:{source}:{sourceId}` TTL 21600 s via `getRedis()`
    (`src/shared/lib/redis.ts`) + in-memory `Map` fallback; on fetch failure cache an
    empty result for 600 s (negative cache); always run results through
    `normalizeEvents`.
  - Verify: `pnpm type-check`; manual: two calls in a row, second logs a cache hit.
- [ ] **API route**
  - Files: `src/routes/api/builders/$builderId/timeline.ts`
  - Do: GET; session required; load the builder row scoped
    `and(eq(builders.id, params.builderId), eq(builders.userId, session.user.id))` (same
    pattern as `src/routes/api/builders/$builderId.ts`) else 404;
    `rateLimit('timeline', userId, 30, 60)` else 429; return `getBuilderTimeline(row)`.
    Catch-all returns `200` with `{ events: [], supported: true }` — never a 5xx from
    upstream failures.
  - Verify: curl a tracked GitHub builder id → events JSON; a non-owned id → 404; 31st
    call in a minute → 429.
- [ ] **BuilderTimeline component**
  - Files: `src/modules/builder-profile/components/BuilderTimeline.tsx`
  - Do: Props `{ builderId, source }`. Fetch on mount (after profile paint) from
    `/api/builders/{builderId}/timeline`; render vertical event list (type icon, linked
    title, relative time, truncated description); filter chips All / Code / Writing / Q&A
    (client-side); three states: skeleton, `supported: false` note ("Activity timeline
    isn't available for {source} profiles"), empty ("No public activity in the last
    year").
  - Verify: UI check on a GitHub builder (events render, chips filter) and an npm builder
    (quiet note).
- [ ] **Mount in the profile page**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: Render `<BuilderTimeline builderId={…} source={…} />` below the existing cards;
    do not touch `HygieneCard` / `OutreachCopilot` placement.
  - Verify: profile page renders with and without timeline data; no layout shift on load
    (reserve min-height for the skeleton).

## Phase 3 — Remaining fetchers (one task each, shippable individually)

- [ ] **HN fetcher (Algolia author search)**
  - Files: `src/lib/timeline/fetchers/hn.ts`, `src/lib/timeline/fetchers/hn.test.ts`, `src/lib/timeline/index.ts`
  - Do: GET `https://hn.algolia.com/api/v1/search_by_date?tags=author_{username},(story,comment)&hitsPerPage=30`
    (URL-encode username); story → `post`, comment → `comment` with the HTML-entity
    stripping approach from `src/lib/sources/hn.ts`; flip `hn` to supported.
  - Verify: `pnpm test hn` fixtures; UI check on an HN builder.
- [ ] **dev.to fetcher**
  - Files: `src/lib/timeline/fetchers/devto.ts`, `src/lib/timeline/fetchers/devto.test.ts`, `src/lib/timeline/index.ts`
  - Do: GET `{env.DEVTO_API_URL}/articles?username={username}&per_page=30` → `article`
    events (`published_at` timestamp); flip `devto` to supported.
  - Verify: fixture test; UI check.
- [ ] **Stack Overflow fetcher**
  - Files: `src/lib/timeline/fetchers/stackoverflow.ts`, `src/lib/timeline/fetchers/stackoverflow.test.ts`, `src/lib/timeline/index.ts`
  - Do: GET `https://api.stackexchange.com/2.3/users/{sourceId}/answers?order=desc&sort=activity&site=stackoverflow&pagesize=30`
    (+`key` from `env.STACKOVERFLOW_API_KEY` when set) → `answer` events linking
    `https://stackoverflow.com/a/{answer_id}`; flip supported.
  - Verify: fixture test; UI check.
- [ ] **GitLab fetcher**
  - Files: `src/lib/timeline/fetchers/gitlab.ts`, `src/lib/timeline/fetchers/gitlab.test.ts`, `src/lib/timeline/index.ts`
  - Do: GET `https://gitlab.com/api/v4/users/{sourceId}/events?per_page=30` (optional
    `PRIVATE-TOKEN` from `env.GITLAB_TOKEN`); pushed → `repo`, opened merge request →
    `pr`, created project → `repo`; flip supported.
  - Verify: fixture test; UI check.

## Phase 4 — Optional AI summary (after ai-expansion)

- [ ] **Register `timeline-summary` task**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: `local-first`; input `{ events: [{ type, title, timestamp }] }` (≤ 20, titles via
    `wrapUntrusted`); output `z.object({ summary: z.string().min(10).max(400) })`;
    `cacheTtlSeconds: 21600`; allowances `{ free: 10, pro: 100, team: 200 }`;
    `maxOutputTokens: 160`.
  - Verify: `pnpm test tasks`.
- [ ] **Summarize button**
  - Files: `src/modules/builder-profile/components/BuilderTimeline.tsx`
  - Do: "Summarize activity" button calling `ai('timeline-summary', { events })`
    (`src/shared/lib/ai/client.ts`); render the summary inline; hide the button on
    `AIUnavailableError` or when `/api/ai/config` reports disabled and Chrome AI is
    unavailable.
  - Verify: UI check in Chrome (local, instant) and Firefox (server fallback); with
    `AI_DISABLED=true` + non-Chrome the button is absent.
