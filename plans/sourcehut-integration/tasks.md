# Tasks: SourceHut Integration

> **Note: deferred**. This is an honorable mention, not a top priority. Plan only; do not execute until GitLab integration is shipped and validated.

## Phase 0 — Research

- [ ] Read SourceHut GraphQL schema: `https://sr.ht/query`
- [ ] Confirm endpoint URLs and auth methods
- [ ] Test query for `queryUsers(search: "rust")`

## Phase 1 — Data model

- [ ] No schema changes; `source: 'sourcehut'`

## Phase 2 — GraphQL client

- [ ] New file `src/lib/sources/sourcehut.ts`
- [ ] `searchSourceHutUsers(keywords, token?)`:
  - GraphQL query: `query { users(search: "X", first: 20) { ... } }`
  - Map to `RawBuilder` with `kind: 'person'`
- [ ] `searchSourceHutRepos(keywords, token?)`:
  - GraphQL query for repos
  - Map to `RawBuilder` with `kind: 'repo'`
- [ ] Combine in `searchSourceHut(keywords, token?)`

## Phase 3 — Wire into pipeline

- [ ] Add `SOURCE_HUT_TOKEN` to env (optional)
- [ ] Add to `search.ts`, `Source` type, default active sources (off by default)
- [ ] Add `SourceHutIcon` to `BrandIcons.tsx`
- [ ] Add `.badge-sourcehut` to globals.css

## Phase 4 — Scoring

- [ ] Bio match (×10)
- [ ] Repo count (log scale, ×2)
- [ ] Recency of last commit (×5 if last week)

## Phase 5 — Verification

- [ ] Manual: search "rust" → see SourceHunt users
- [ ] Performance: < 1s per search (GraphQL is fast)
- [ ] Rate limit handling

## Estimated effort

M (3-4 días) — GraphQL client + new auth flow + niche data validation.
