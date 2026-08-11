# Feature: Hashnode Integration

> **Status**: `retired`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector exists at `src/lib/sources/hashnode.ts` and is fully wired
> (pipeline, pill, badge, icon, scoring, `HASHNODE_API_KEY` env var) — but it targets the
> **dead legacy endpoint** `https://api.hashnode.com/` (verified 2026-07-19: every request
> returns `{"errors":[{"message":"Stellate service \"api.hashnode.com\" not found"}]}`), so
> the source always returns zero results in production.

## Problem

Hashnode is DEV.to's sibling: developers who write, often with personal domains and a more
professional-blogger profile. Complementary writing-signal coverage.

## Goal

Index Hashnode writers as `RawBuilder` person records with real follower counts.

## Delivered

Shipped in `src/lib/sources/hashnode.ts`:

- GraphQL client with graceful degradation: HTTP errors, GraphQL errors, and network
  failures all return `[]`, so the dead endpoint has zero impact on federated search
  (`search.ts` uses `Promise.all`; this containment is mandatory).
- `searchHashnode(keywords, {page, perPage})` running a `searchUsers` GraphQL query,
  mapping to `kind: 'person'` with real `followersCount` and `metadata.postCount`.
- Optional `HASHNODE_API_KEY` in `src/shared/lib/env.ts`, sent as `Authorization`.
- Registered in `src/lib/search.ts` and `SourceName` (`src/lib/sources/types.ts`).
- UI: opt-in pill in `ALL_SOURCES` + `SOURCE_META` (`SearchPage.tsx`), `HashnodeIcon` in
  `BrandIcons.tsx`, `.badge-hashnode` in `src/shared/styles/globals.css`.
- Scoring: `hashnode` branch in `src/lib/score.ts` (post-count bonus).

The connector header itself documents this as a "wired but dormant" v1: the source was
built so it starts contributing the moment the API works again. It never did — Hashnode
moved to a new endpoint instead (see gaps).

## Remaining gaps (real, cited from code)

1. **Dead endpoint.** `HN_GQL = 'https://api.hashnode.com/'` (`hashnode.ts` line 39) is the
   retired legacy API. Hashnode's current public GraphQL API lives at
   `https://gql.hashnode.com`. Note the new API has **no `searchUsers` query** — the
   people-yielding path is `user(username)` lookups plus post search by tag
   (`feed`/`searchPostsOfPublication` variants), taking post authors as the people. The
   migration task below documents the honest options.
2. **ID prefix collision with Hacker News.** `hashnode.ts` builds `id: hn-{username}`
   (line 88) while `src/lib/sources/hn.ts` builds `id: hn-{username}` (line 116). Two
   different people with the same handle on both platforms would collide on `id`. Dedup
   keys on `username` anyway (`src/lib/dedup.ts`), but the `id` is used as the React key
   and tracked-builder `source`/`sourceId` disambiguates only because `source` differs —
   the prefix should still be unique (`hnode-`).
3. **`HASHNODE_API_KEY` is missing from `.env.example`.**

## Non-goals (unchanged)

Publication/article indexing (people only); Hashnode Teams.

## Success metrics

- After the endpoint migration: searching a known Hashnode writer's topic returns person
  cards with real follower counts; until then the source must keep costing nothing.
