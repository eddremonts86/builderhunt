# Unified Builder Timeline (spec)

> **Status**: `pending`
> **Depends on**: nothing hard. Soft: [`ai-expansion`](../21-ai-expansion/spec.md) (only for
> the optional `timeline-summary` task — the timeline itself has zero AI); Redis
> (`src/shared/lib/redis.ts`) recommended for the cache, in-memory fallback works.
> **Blocks**: nothing. [`smart-alerts`](../34-smart-alerts/spec.md)' future "real event
> detection" phase would consume these fetchers; [`portfolio-builder`](../37-portfolio-builder/spec.md)
> may embed the component later (both soft, noted there).
> **Reality check**: Builder detail view exists (`src/routes/_dashboard/builder/$builderId/index.tsx`
> → `src/modules/builder-profile/components/BuilderProfilePage.tsx`). Connectors return
> only **aggregate** metadata per profile — e.g. github: `{ publicRepos, createdAt }`
> (`src/lib/sources/github.ts`), devto: `{ articlesCount, reactions, github, twitter }`
> (`src/lib/sources/devto.ts`), hn: `{ submittedCount, lastSeen, matchCount }`
> (`src/lib/sources/hn.ts`) — **no per-event activity exists anywhere**. A `builders` row
> is single-source (`source`, `sourceId`, `username`); there is no cross-source identity.

## Problem

A profile card shows _who_ a builder is, not _what they are doing right now_. Recruiters
open 3–4 external tabs to judge momentum (recent repos, posts, answers). The data is one
public API call away per source, but nothing in the app fetches it.

## Goal

A **per-builder recent-activity timeline** on the builder detail view: the last ~30 public
events (repos pushed/created, articles, answers, posts/comments) from **the builder's own
source**, fetched **on demand** when the profile is opened, cached in Redis for hours.
Lean by design: a read-through cache over public per-user endpoints — not an ingestion
pipeline.

## Non-goals

- **No durable ingestion / storage of events.** No DB table, no `builders.metadata.timeline`
  writes. Cache only (Redis TTL + in-memory fallback). A durable event pipeline would need
  the blocked scraping/queue architecture — explicitly rejected.
- **No cross-source timelines in v1.** `builders` rows are single-source and no identity
  linking exists. (Future note: devto metadata already carries a `github` username — a
  cheap two-source join is a Future phase, not v1.)
- **No social sources that aren't live.** Bluesky is a planned connector; hashnode's legacy
  API is dead; sourcehut is token-gated. v1 covers github, hn, devto, gitlab,
  stackoverflow. Others degrade to a clean "no timeline available for {source}" state.
- **No rich media embeds.** Text + link out.

## User stories

1. As a user viewing a GitHub builder, I see their recent public events (pushes, created
   repos, releases, PRs) with timestamps, each linking out.
2. As a user viewing an HN/dev.to/Stack Overflow builder, I see recent posts/articles/answers.
3. As a user on a source without a viable activity API (npm, lobsters, …), I see a quiet
   "Activity timeline isn't available for {source} profiles" note — never an error.
4. (Optional, AI) As a user, I click "Summarize activity" and get a 1–2 sentence local-AI
   summary of the fetched events — instantly, on-device when Chrome AI is available.

## Architecture

### 1. Event model (`src/lib/timeline/types.ts`)

```ts
export type TimelineEventType =
  | "repo"
  | "release"
  | "pr"
  | "post"
  | "article"
  | "answer"
  | "comment";

export interface TimelineEvent {
  id: string; // `${source}:${stable source event id}`
  type: TimelineEventType;
  source: SourceName;
  title: string; // "Pushed 3 commits to foo/bar", "Published: …", "Answered: …"
  description?: string; // truncated body/summary, plain text
  url: string;
  timestamp: string; // ISO 8601
}

export interface TimelineResult {
  events: TimelineEvent[]; // sorted desc, ≤ 30
  source: SourceName;
  supported: boolean; // false ⇒ UI shows the "not available" note
  fetchedAt: string;
}
```

### 2. Per-source fetchers (`src/lib/timeline/fetchers/*.ts`)

Each exports `fetchXEvents(builder: { username, sourceId }): Promise<TimelineEvent[]>`,
follows connector conventions (try/catch → `[]`, `User-Agent: BuilderHunt/1.0`,
`AbortSignal.timeout(5000)`), uses the existing optional tokens from `env.ts`:

| Source        | Endpoint (public)                                                                                                                  | Events derived                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| github        | `GET /users/{username}/events/public` (optional `GITHUB_TOKEN`)                                                                    | PushEvent → `repo` ("Pushed N commits to X"), CreateEvent(repository) → `repo`, ReleaseEvent → `release`, PullRequestEvent(opened) → `pr` |
| hn            | Algolia `GET /api/v1/search_by_date?tags=author_{username},(story,comment)`                                                        | story → `post`, comment → `comment` (reuse the HTML-entity stripper pattern from `src/lib/sources/hn.ts`)                                 |
| devto         | `GET {DEVTO_API_URL}/articles?username={username}`                                                                                 | `article`                                                                                                                                 |
| gitlab        | `GET /api/v4/users/{sourceId}/events` (sourceId is the numeric user id; optional `GITLAB_TOKEN`)                                   | pushed/created/merged → `repo`/`pr`                                                                                                       |
| stackoverflow | `GET /2.3/users/{sourceId}/answers?order=desc&sort=activity&site=stackoverflow&filter=withbody` (optional `STACKOVERFLOW_API_KEY`) | `answer` (title from the question when the filter provides it, else "Answered a question")                                                |

Unsupported sources (npm, huggingface, reddit, lobsters, codeberg, hashnode, sourcehut)
return `supported: false` from the service — kept honest and cheap; each can graduate to a
fetcher later without schema work.

### 3. Normalizer (`src/lib/timeline/normalize.ts` — pure, tested)

`normalizeEvents(events: TimelineEvent[]): TimelineEvent[]` — sort by timestamp desc,
drop events with future timestamps or older than 365 days, dedupe by `id`, cap at 30,
truncate `description` to 280 chars.

### 4. Service + cache (`src/lib/timeline/index.ts`)

`getBuilderTimeline({ source, sourceId, username })`:

1. Cache key `timeline:{source}:{sourceId}`; Redis `GET` (via `getRedis()`), **TTL 6 h**;
   in-memory `Map` fallback mirroring `src/lib/search.ts`'s two-layer approach.
2. Miss → dispatch to the source's fetcher (single source — no fan-out), normalize, cache,
   return. Fetch failure with an empty cache → `{ events: [], supported: true, ... }` and
   a **short negative-cache (10 min)** so a dead upstream isn't hammered per page view.

### 5. API route (`GET /api/builders/$builderId/timeline`)

- Auth required; row ownership enforced exactly like
  `src/routes/api/builders/$builderId.ts` (`and(eq(builders.id), eq(builders.userId, session.user.id))`).
- Rate limit `('timeline', userId, 30, 60)` (`src/shared/lib/rate-limit.ts`).
- Reads `source`/`sourceId`/`username` from the row, returns `TimelineResult`.
- Never 500s on upstream failure — degraded empty result instead.

### 6. UI (`src/modules/builder-profile/components/BuilderTimeline.tsx`)

- Section inside `BuilderProfilePage.tsx`, below the existing cards (`HygieneCard`,
  `OutreachCopilot` remain untouched).
- Vertical list: type icon, title (link), relative time, optional description.
- Filter chips: All / Code (`repo`,`release`,`pr`) / Writing (`article`,`post`) /
  Q&A (`answer`,`comment`) — client-side filtering of the fetched set.
- States: skeleton while loading; `supported: false` → quiet note; empty events →
  "No public activity in the last year".
- Lazy: fetched when the section scrolls into view or on mount after profile paint —
  never blocks profile render.

## AI task (optional, per `_meta/ai-policy.md`)

**`timeline-summary`** — "Summarize this builder's recent activity" button.

- **Tier policy**: `local-first` (interactive + ephemeral + this-user-only → Chrome AI,
  Summarizer/Prompt API; `/api/ai/complete` MiniMax fallback for parity).
- **Input schema**: `{ events: Array<{ type, title, timestamp }> }` (≤ 20 items, titles are
  external content → `wrapUntrusted` in `buildPrompt`; well under the ~6k Chrome window).
- **Output schema**: `z.object({ summary: z.string().min(10).max(400) })`.
- **Cache TTL**: 6 h (matches the timeline cache — same input ⇒ same key).
- **Allowances**: `{ free: 10, pro: 100, team: 200 }` per day. **maxOutputTokens**: 160.
- **Fallback ladder**: Chrome AI → server proxy → on `AIUnavailableError` the button hides
  (no rule-based rung — a heuristic summary adds nothing over the visible list).
- **Cost**: expected ≥ 70% Tier-1 (Chrome). Server residue ~350 in / 160 out tokens per
  call, cached 6 h per builder — cents/month at current scale.

## Success metrics

- Warm-cache timeline response p95 < 50 ms; cold fetch < 3 s (single upstream).
- ≥ 30% of builder-profile views scroll to / interact with the timeline section.
- Zero upstream-caused 5xx from the timeline endpoint (degradation verified).

## Resolved edge cases

- **Renamed/deleted upstream user**: fetcher gets 404 → `[]` → negative-cached empty state.
- **HN usernames with special chars**: URL-encode the `author_` tag.
- **GitHub events for orgs/repos rows** (`kind: 'repo'` builders): tracked rows can be
  repos (`username` = `owner/name`); the github fetcher detects a `/` and skips to
  `supported: false` (repo timelines are a different endpoint — Future).
- **Rate-limited upstream (403/429)**: treated as fetch failure → negative cache, so at
  most one attempt per 10 min per builder.
- **Redis absent**: in-memory cache still prevents per-view refetch on one instance;
  documented best-effort, same trade-off as `search.ts`.
