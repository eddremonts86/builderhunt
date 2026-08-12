# Feature: Product Hunt Integration

> **Status**: `implemented` — wired but dormant until a token is provisioned
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: `src/lib/sources/producthunt.ts` implemented 2026-07-25, token-gated
> exactly like `src/lib/sources/sourcehut.ts` (returns `[]` when `PRODUCTHUNT_TOKEN` is
> unset — verified live). Provisioning a real Developer Token requires a human (real PH
> account); see `tasks.md` for the full write-up. Downstream `unified-timeline` /
> `proactive-discovery` are enhanced by this source, not blocked.

## Problem

Code activity misses product-minded builders: makers who ship and launch. Product Hunt is
the canonical record of launched products and exposes their makers — with `gitHubUsername`
and `twitterUsername` fields that bridge identities across sources.

## Goal

Index Product Hunt makers as `RawBuilder` person records, discovered through the products
they launched.

## API viability (honest assessment)

- **Official API v2 (GraphQL)**: `https://api.producthunt.com/v2/api/graphql`.
- **Auth is mandatory**: `Authorization: Bearer {PRODUCTHUNT_TOKEN}` (a "Developer Token"
  from api.producthunt.com/v2/docs, tied to a PH account/app). Without a token the source
  MUST be silently empty (`[]`), the same wired-but-dormant pattern as
  `src/lib/sources/sourcehut.ts`.
- **Rate limit**: complexity-point based, 6250 points / 20 min for GraphQL requests. One
  search = 1-2 small queries; BuilderHunt's 5-min search cache keeps this trivial.
- **Critical constraint the previous draft got wrong**: the v2 `posts` query has **no
  free-text `search` argument**. Discovery must go through topics:
  1. Resolve the query keyword to a topic slug: `topics(first: 1, query: $q)` (or a small
     hardcoded keyword->slug map for common stacks: `ai`, `developer-tools`, `saas`,
     `productivity` — verify exact slugs at implementation time via introspection).
  2. Fetch posts for that topic: `posts(first: 20, topic: $slug, order: VOTES)` with
     `makers { id name username headline profileImage twitterUsername }` and
     `votesCount`, `topics { nodes { slug } }`, `createdAt`.
  3. Aggregate makers across matched posts (same author-aggregation pattern as
     `src/lib/sources/huggingface.ts`).
     Keywords that resolve to no topic yield `[]` — acceptable and honest; PH simply cannot
     answer arbitrary keyword queries.

## Which endpoint yields PEOPLE

`Post.makers` is the people source. Makers are aggregated across posts; each maker card is
a person, each post can optionally become a `kind: 'repo'` resource card.

## RawBuilder mapping

```ts
// person (aggregated maker)
{
  id: `ph-${user.id}`,
  kind: 'person',
  source: 'producthunt',
  sourceId: String(user.id),
  username: user.username,
  displayName: user.name ?? undefined,
  avatarUrl: user.profileImage ?? undefined,
  bio: user.headline ?? undefined,
  profileUrl: `https://www.producthunt.com/@${user.username}`,
  followersCount: totalVotesAcrossMatchedPosts, // votes proxy; v2 exposes no follower count on makers cheaply
  language: undefined,
  country: undefined,
  topics: topicSlugsFromMatchedPosts,           // max 10
  metadata: {
    launchedCount: matchedPosts.length,
    totalVotes,
    bestVotes,
    lastSeen: Date.parse(newestPost.createdAt), // real recency for score.ts
    launches: matchedPosts.slice(0, 5).map(p => ({ name, tagline, votesCount, url })),
    twitterUsername: user.twitterUsername ?? null,
    // NOTE: if schema introspection confirms `gitHubUsername` on User/Maker, include it —
    // it is the cross-source dedup bridge.
  },
}
// repo (optional, the launched product): id `ph-post-{id}`, votesCount as followersCount
```

## Dedup / score interplay

- `src/lib/dedup.ts` keys on `username.toLowerCase()` — a PH maker whose username equals
  their GitHub login merges automatically (metadata union, max followers). No dedup code
  changes; do NOT build bespoke gitHubUsername matching in v1 (that belongs to a future
  cross-source-identity plan).
- `src/lib/score.ts`: add a `producthunt` branch — log-scale bonus on `metadata.bestVotes`
  (capped ~10) mirroring the `huggingface` totalDownloads bonus. `metadata.lastSeen` gives
  real recency scoring for free.

## Failure behavior (non-negotiable)

`src/lib/search.ts` uses `Promise.all`; the connector wraps every request in try/catch and
returns `[]` on: missing token, 401 (expired token), 429/complexity exhaustion, GraphQL
errors, network failure. Mirror the `gql<T>()` helper in `src/lib/sources/sourcehut.ts`.

## Env

`PRODUCTHUNT_TOKEN` (optional) added to `src/shared/lib/env.ts` and documented in
`.env.example`. Feature hides itself (empty results) when unset.

## UX integration

`producthunt` in `SourceName`, `Builder.source` union, `ALL_SOURCES` + `SOURCE_META`
(opt-in) in `SearchPage.tsx`, `PersonResultCard.tsx`; `ProductHuntIcon` in
`BrandIcons.tsx`; `.badge-producthunt` (brand `#da552f`) in `src/shared/styles/globals.css`.

## Non-goals

Upvoting/reviewing from BuilderHunt; free-text product search (the API cannot do it);
"Launched products" profile widget (defer to builder-profile work); GitHub-username-based
dedup logic.

## Success metrics

- With a token: searching "ai" or "developer tools" with only the PH pill active returns
  maker cards with launch counts and vote totals; topic-less keywords cleanly return
  nothing from this source.
- Without a token: zero requests, zero errors, zero results.
