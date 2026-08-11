# Plan: Bluesky Integration

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Greenfield connector following the existing pattern exactly; closest
> analogs are `src/lib/sources/codeberg.ts` (clean two-call REST source) and the
> registration checklist visible in `src/lib/search.ts` / `SearchPage.tsx`. Verified: the
> public AppView answers unauthenticated `searchActors` and `getProfiles` today.

## Phases (dependency order)

### Phase 1 — Connector

`src/lib/sources/bluesky.ts` exporting
`searchBluesky(keywords: string[], options: { page?: number; perPage?: number } = {}): Promise<RawBuilder[]>`:

1. `GET https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q={keywords joined}&limit=25`
   with the standard `User-Agent: BuilderHunt/1.0 (bluesky source)` header.
2. Hydrate all hits in **one** `app.bsky.actor.getProfiles` call (25-actor cap matches the
   search limit) to get follower/follows/posts counts.
3. Map to `RawBuilder` per the spec; extract `#hashtags` from bios as topics; sort by
   `followersCount` desc; slice by `page`/`perPage` like every other connector.
4. Every fetch try/caught; hydration failure degrades to countless profiles, search
   failure degrades to `[]`. This is mandatory — `search.ts` uses `Promise.all`.

### Phase 2 — Registration

- `bluesky` in `SourceName` (`src/lib/sources/types.ts`).
- Import + `if (sources.includes('bluesky')) tasks.push(searchBluesky(keywords, { page, perPage }))`
  in `src/lib/search.ts`.

### Phase 3 — UI

- `Builder.source` union, `ALL_SOURCES`, `SOURCE_META.bluesky` in `SearchPage.tsx`
  (opt-in); `SOURCE_META` in `PersonResultCard.tsx`.
- `BlueskyIcon` in `BrandIcons.tsx`; `.badge-bluesky` in `src/shared/styles/globals.css`.

### Phase 4 — Scoring nuance

`bluesky` branch in `src/lib/score.ts`: +5 for custom-domain handles
(`metadata.customDomainHandle`). Everything else rides the default paths (no
`metadata.lastSeen` in v1 -> neutral recency).

## Risks

| Risk                                      | Likelihood | Impact | Mitigation                                                                        |
| ----------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------- |
| Fuzzy actor search returns non-developers | Medium     | Medium | Opt-in pill; scoring favors complete profiles; users toggle it per query          |
| AppView rate limiting under load          | Low        | Low    | 2 requests/search behind the 5-min cache in `search.ts`                           |
| No recency signal (no lastSeen)           | Certain    | Low    | Accepted v1 tradeoff; `getAuthorFeed` enrichment can come with `unified-timeline` |

## Rollback plan

No migrations, no env vars. Remove `'bluesky'` from `ALL_SOURCES` to hide; remove the gate
in `search.ts` to disable.
