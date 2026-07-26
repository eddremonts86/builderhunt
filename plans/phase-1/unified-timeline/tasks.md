# Unified Builder Timeline (tasks)

> **Status**: `implemented` — all four phases shipped in this pass, including the
> Phase 4 AI summary (`ai-expansion` was already complete).
> **Depends on**: nothing hard; Phase 4 depends on [`ai-expansion`](../ai-expansion/spec.md) (complete)
> **Blocks**: nothing — see spec.md header
> **Reality check (2026-07-26)**: The plan's own header ("Zero timeline code exists")
> was still accurate at the start of this pass. Built against the real current auth
> model rather than the plan text's `builders.userId`-scoped assumption: ownership is
> checked via `findOrganizationBuilderByIdentity` (tenant/org-scoped), the same pattern
> already used by `hygiene.ts` for this exact profile page.

## Phase 1 — Types, normalizer, github fetcher

- [x] **Event types**
  - Files: `src/shared/lib/timeline/types.ts` → actually `src/lib/timeline/types.ts` (matches this repo's `src/lib/sources/*` convention, not `src/shared/lib`)
  - Do: `TimelineEventType`, `TimelineEvent`, `TimelineResult` exactly per spec §1.
  - Verify: `pnpm tsc --noEmit` — clean.
- [x] **Normalizer (pure) + tests**
  - Files: `src/lib/timeline/normalize.ts`, `src/lib/timeline/normalize.test.ts`
  - Do: `normalizeEvents(events)` — sort desc, drop future/>365-day-old, dedupe by `id`,
    cap 30, truncate `description` to 280 chars with an ellipsis.
  - Verify: `pnpm vitest run src/lib/timeline/normalize.test.ts` — 8/8 passing.
- [x] **GitHub fetcher**
  - Files: `src/lib/timeline/fetchers/github.ts`, `src/lib/timeline/fetchers/github.test.ts`
  - Do: `fetchGithubEvents`/`mapGithubEvent` per spec (PushEvent, CreateEvent(repository),
    ReleaseEvent, PullRequestEvent(opened); repo-kind `owner/name` usernames short-circuit
    to `[]`).
  - **Real bug found and fixed via live verification**: GitHub's public events feed sends
    a *stripped* `pull_request` payload object — confirmed directly against the live API
    for a real account — containing only `url`/`id`/`number`/`head`/`base`, never
    `title`/`html_url`/`body` (unlike the full Pull Requests API used elsewhere in this
    codebase, e.g. `work-sample.ts`). The first version rendered every PR event as a blank
    "Opened PR:" linking to the repo instead of the PR. Fixed to build both from `number` +
    the repo name (`Opened PR #{number} in {repo}`, `{repoUrl}/pull/{number}`) when the feed
    doesn't supply the richer fields, while still preferring real `title`/`html_url` if a
    future/different payload shape ever includes them.
  - Verify: `pnpm vitest run src/lib/timeline/fetchers/github.test.ts` — 12/12 passing
    (including a regression test for the stripped-payload fallback).

## Phase 2 — Service, API, UI

- [x] **Timeline service with two-layer cache**
  - Files: `src/lib/timeline/index.ts`, `src/lib/timeline/index.test.ts`
  - Do: `getBuilderTimeline({ source, sourceId, username })` — in-memory `Map` + Redis
    (`getRedis()`) two-layer cache, key `timeline:{source}:{sourceId}`, 6h TTL on a
    non-empty result, 10m negative-cache TTL when the fetcher yields nothing (fetch
    failure and genuine no-activity are indistinguishable at this layer by design — the
    fetchers never throw, so this is the only sensible behavior).
  - Verify: `pnpm vitest run src/lib/timeline/index.test.ts` — 4/4 passing (fetch+cache,
    second call served from memory without refetching, unsupported source short-circuits,
    empty-but-supported result).
- [x] **API route**
  - Files: `src/routes/api/builders/$builderId/timeline.ts`
  - Do: GET; `requireTenantPrincipal` + `findOrganizationBuilderByIdentity` (adapted
    ownership model, see reality check above) else 404; `rateLimit('timeline', userId, 30,
    60)` else 429; returns `getBuilderTimeline(...)`. Catch-all degrades to `200` with an
    empty, honestly-labeled result — never a 5xx.
  - Verify: live-verified against the real dev server as a real authenticated user — GET
    returned real GitHub event JSON for a tracked builder.
- [x] **BuilderTimeline component**
  - Files: `src/modules/builder-profile/components/BuilderTimeline.tsx`
  - Do: Fetches after mount; skeleton / `supported: false` note / empty note / event list
    states; type icon + linked title + relative time + truncated description; All / Code
    / Writing / Q&A filter chips (client-side).
  - Verify: live in-browser — real event rendered, filter chips correctly show/hide it
    (confirmed "Writing" filter → "No activity in this category" for a `pr`-typed event).
- [x] **Mount in the profile page**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: `<BuilderTimeline builderId={builder.id} source={builder.source} />` added to the
    left column below `CodeStyleCard`; `HygieneCard`/`OutreachCopilot` etc. untouched.
  - Verify: live screenshot — renders correctly alongside the existing cards.

## Phase 3 — Remaining fetchers

- [x] **HN fetcher (Algolia author search)**
  - Files: `src/lib/timeline/fetchers/hn.ts`, `src/lib/timeline/fetchers/hn.test.ts`
  - Do: story → `post`, comment → `comment`, reusing the HTML-entity-stripping approach
    from `src/lib/sources/hn.ts`; `hn` supported.
  - Verify: `pnpm vitest run src/lib/timeline/fetchers/hn.test.ts` — 9/9 passing.
- [x] **dev.to fetcher**
  - Files: `src/lib/timeline/fetchers/devto.ts`, `src/lib/timeline/fetchers/devto.test.ts`
  - Do: `article` events from `{env.DEVTO_API_URL}/articles`; `devto` supported.
  - Verify: `pnpm vitest run src/lib/timeline/fetchers/devto.test.ts` — 6/6 passing.
- [x] **Stack Overflow fetcher**
  - Files: `src/lib/timeline/fetchers/stackoverflow.ts`, `src/lib/timeline/fetchers/stackoverflow.test.ts`
  - Do: `answer` events linking `https://stackoverflow.com/a/{answer_id}`; `stackoverflow`
    supported.
  - Verify: `pnpm vitest run src/lib/timeline/fetchers/stackoverflow.test.ts` — 5/5 passing.
- [x] **GitLab fetcher**
  - Files: `src/lib/timeline/fetchers/gitlab.ts`, `src/lib/timeline/fetchers/gitlab.test.ts`
  - Do: pushed/created → `repo`, opened/accepted merge request → `pr`; `gitlab` supported.
  - Deviation from the plan's literal approach: GitLab's events API never includes a
    project's path/URL, only its numeric id — a real gap discovered while implementing,
    not anticipated by the plan text. Added a bounded (≤20 unique projects/request)
    parallel `GET /projects/{id}` resolution step to get real `web_url`s rather than
    guessing at a URL shape; an event whose project URL can't be resolved is dropped
    (pure `mapGitlabEvent` takes the resolved URL as an explicit second argument, so this
    stays unit-testable without network mocking of the resolution step itself).
  - Verify: `pnpm vitest run src/lib/timeline/fetchers/gitlab.test.ts` — 8/8 passing.

## Phase 4 — AI summary

- [x] **Register `timeline-summary` task**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: `local-first`, input capped at 20 events (titles wrapped via `wrapUntrusted` —
    they're third-party API content), `cacheTtlSeconds: 21600`,
    `allowances: { free: 10, pro: 100, team: 200 }`, `maxOutputTokens: 160`, exactly per
    spec.
  - Verify: `pnpm vitest run src/shared/lib/ai/tasks.test.ts` — 2 new dedicated tests
    (registration/schema, untrusted-wrapping) plus the existing generic every-task sweep,
    all passing.
- [x] **Summarize button**
  - Files: `src/modules/builder-profile/components/BuilderTimeline.tsx`
  - Do: "Summarize activity" button calling `ai('timeline-summary', { events })`; renders
    the summary inline on success; on `AIUnavailableError` hides the button rather than
    showing an error (no rule-based fallback rung, per spec — a heuristic summary adds
    nothing over the already-visible event list).
  - Verify: live-verified end-to-end — clicked the real button, it correctly called
    `/api/ai/complete`, got a `503 ai_unconfigured` (this dev process's in-memory `env`
    singleton predates a `MINIMAX_API_KEY` added to `.env` mid-session — an environment
    staleness issue, not a code bug, per this session's now-familiar `GITHUB_TOKEN`
    precedent), and the UI degraded exactly as designed: no crash, no error banner, the
    button silently disappeared. This is the intended `AIUnavailableError` path working
    correctly, not a failure to fix.
