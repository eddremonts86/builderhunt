# Feature: Bluesky Integration

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: No `src/lib/sources/bluesky.ts` exists and `bluesky` is not in the
> `SourceName` union (`src/lib/sources/types.ts`). The connector must copy the existing
> pattern (one file, `search<Name>(keywords, opts) -> RawBuilder[]`, registered in
> `src/lib/search.ts`). Downstream consumers `unified-timeline` and `proactive-discovery`
> are enhanced by this source but do not depend on it.

## Problem

Many builders moved their "building in public" discourse to Bluesky (AT Protocol). Without
it, BuilderHunt misses an active demographic whose bios and handles (often custom domains)
are strong identity signals.

## Goal

Index Bluesky actors as `RawBuilder` person records via the public AppView — no auth, no
API key.

## API facts (verified 2026-07-19 against the live API)

- **Base**: `https://public.api.bsky.app/xrpc/`
- **Auth**: none for public reads. No env var required for v1.
- **People endpoint** (this IS a people search — actors are users):
  `GET app.bsky.actor.searchActors?q={q}&limit=25` — fuzzy match on handle, display name,
  and bio. Returns `actors[]` as `ProfileView` (did, handle, displayName, avatar,
  description) — **without follower counts**.
- **Batch profile hydration**:
  `GET app.bsky.actor.getProfiles?actors={did1}&actors={did2}...` — up to **25 actors per
  call**, returns `ProfileViewDetailed` incl. `followersCount`, `followsCount`,
  `postsCount`. One search + one batch call = 2 requests per uncached search.
- **Rate limits**: per-IP on the public AppView, generous (order of 3000 req/5 min);
  BuilderHunt's 2 req/search behind the 5-minute search cache is far below it.
- **Not fetched in v1**: `app.bsky.feed.getAuthorFeed` (recent posts / last-active). It
  costs one request per actor; without it there is no `metadata.lastSeen`, and
  `src/lib/score.ts` assigns the neutral 5-point recency default. Acceptable v1 tradeoff;
  posts belong to the `unified-timeline` plan anyway.

## RawBuilder mapping

```ts
{
  id: `bsky-${actor.did}`,
  kind: 'person',
  source: 'bluesky',
  sourceId: actor.did,                    // did:plc:...
  username: actor.handle,                 // e.g. alice.dev or alice.bsky.social
  displayName: actor.displayName ?? undefined,
  avatarUrl: actor.avatar ?? undefined,   // CDN URL
  bio: actor.description ?? undefined,
  profileUrl: `https://bsky.app/profile/${actor.handle}`,
  followersCount: detailed?.followersCount,  // from getProfiles batch
  language: undefined,
  country: undefined,                     // not exposed by the protocol
  topics: hashtagsFrom(actor.description),   // `#rust` -> `rust`, max 8
  metadata: {
    did: actor.did,
    followsCount: detailed?.followsCount,
    postsCount: detailed?.postsCount,
    customDomainHandle: !actor.handle.endsWith('.bsky.social'),
  },
}
```

## Dedup / score interplay

- `src/lib/dedup.ts` keys on `username.toLowerCase()`. Bluesky handles are domains
  (`alice.bsky.social`), so cross-source merges with e.g. GitHub logins are naturally rare
  — no dedup changes needed.
- `src/lib/score.ts` default path already handles Bluesky: log-followers popularity,
  neutral recency, topics, quality points. Add a small `bluesky` branch: +5 when
  `metadata.customDomainHandle` (a custom domain is a deliberate identity/verification
  act).

## Failure behavior (non-negotiable)

`src/lib/search.ts` runs sources with `Promise.all` — a rejected promise kills the whole
federated search. Every fetch in the connector must be wrapped in try/catch and return
`[]`/partial data. If the `getProfiles` hydration fails, return the search hits without
follower counts rather than nothing.

## UX integration

- `bluesky` added to `SourceName` (`src/lib/sources/types.ts`), the `Builder.source` union
  in `SearchPage.tsx`, `ALL_SOURCES` + `SOURCE_META` (opt-in — NOT in
  `DEFAULT_ACTIVE_SOURCES`, matching how all post-launch sources shipped), and
  `PersonResultCard.tsx`'s `SOURCE_META`.
- `BlueskyIcon` (butterfly) in `src/modules/landing/components/BrandIcons.tsx`;
  `.badge-bluesky` in `src/shared/styles/globals.css` using brand blue `#0085ff` at the
  same alpha pattern as the neighboring badges.

## Non-goals

Posting/social actions; rendering post feeds (unified-timeline's job); AT Protocol PDS
hosting; location/language inference from bios (leave `country`/`language` undefined).

## Success metrics

- Searching "rust", "indie hacker", or "typescript" with only the Bluesky pill active
  returns person cards with avatars, bios, and real follower counts.
- Bluesky outage or rate-limit changes nothing except that source's contribution.
