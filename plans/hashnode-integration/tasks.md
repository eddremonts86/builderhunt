# Tasks: Hashnode Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped but the API endpoint it targets is dead;
> the source returns `[]` in production. Remaining: endpoint migration, id-prefix fix,
> env docs.

## Delivered

- [x] **GraphQL connector with graceful degradation** — Done:
      `src/lib/sources/hashnode.ts` (`searchHashnode(keywords, {page, perPage})`; all failure
      modes return `[]`, so the dead API never breaks federated search).
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `hashnode` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **Add `HASHNODE_API_KEY` env var** — Done: `src/shared/lib/env.ts` (optional).
- [x] **UI source pill + metadata** — Done: `ALL_SOURCES` + `SOURCE_META.hashnode` in
      `SearchPage.tsx` (opt-in); `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `HashnodeIcon` in `BrandIcons.tsx`; `.badge-hashnode`
      in `src/shared/styles/globals.css`.
- [x] **Scoring** — Done: `hashnode` branch in `src/lib/score.ts` (followers + post-count
      bonus).

## Remaining

- [ ] **Migrate the connector to `https://gql.hashnode.com`**
  - Files: `src/lib/sources/hashnode.ts`
  - Do: replace `HN_GQL` with `https://gql.hashnode.com`. The new API has no `searchUsers`;
    implement discovery as: query posts by the search term/tag (new-API post search),
    collect `author { username name profilePicture followersCount }` from matched posts,
    aggregate authors (same pattern as `aggregateAuthor` in
    `src/lib/sources/huggingface.ts`), set `metadata.postCount` = matched posts,
    `metadata.lastSeen` = newest matched post `publishedAt`. Keep the exported signature
    and the degrade-to-`[]` wrapper. Send `HASHNODE_API_KEY` as `Authorization` when set.
  - Verify: `curl -X POST https://gql.hashnode.com -H 'Content-Type: application/json'`
    with the final query returns data; then search a common tag (e.g. "javascript") with
    only the Hashnode pill active and see person cards.

- [ ] **Fix `hn-` id prefix collision with the Hacker News source**
  - Files: `src/lib/sources/hashnode.ts`
  - Do: change `id: hn-${u.username}` to `id: hnode-${u.username}` (the `hn-` prefix is
    taken by `src/lib/sources/hn.ts` line 116; `sourceId` stays the raw username).
  - Verify: `grep -n "id: \`hn-" src/lib/sources/hashnode.ts` returns nothing.

- [ ] **Document `HASHNODE_API_KEY` in `.env.example`**
  - Files: `.env.example`
  - Do: add `HASHNODE_API_KEY=` under "External Source API Tokens" (comment: optional
    Personal Access Token from hashnode.com > Developer Settings; raises rate limits).
  - Verify: `grep HASHNODE_API_KEY .env.example` prints the documented line.
