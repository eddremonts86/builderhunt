# Plan: Hashnode Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: The original "likely skip" decision is obsolete — the connector was
> built and wired (`src/lib/sources/hashnode.ts`) but targets the dead legacy endpoint, so
> it is functionally dormant. The remaining work is a small, well-scoped migration.

## Executed phases (record)

1. **GraphQL client + user search** — `src/lib/sources/hashnode.ts` (graceful `[]` on all
   failures — verified: the legacy endpoint fails 100% of the time today).
2. **Pipeline** — import + gate in `src/lib/search.ts`; `hashnode` in `SourceName`.
3. **Env** — optional `HASHNODE_API_KEY` in `src/shared/lib/env.ts`.
4. **UI** — opt-in pill, `SOURCE_META.hashnode`, `HashnodeIcon`, `.badge-hashnode`.
5. **Scoring** — `hashnode` branch in `src/lib/score.ts`.

## Remaining phases

### Phase A — Migrate to `https://gql.hashnode.com`

The new public API differs materially:

- No `searchUsers` query exists. People-yielding options:
  1. `user(username: $u)` — exact lookup only (username, name, bio, followersCount,
     posts count). Good for enrichment, useless for keyword discovery alone.
  2. Post search by tag/term (the API exposes tag feeds and post search), then aggregate
     `author` fields — this is the discovery path: keyword -> matching posts -> authors,
     aggregated exactly like the Lobsters/HuggingFace author-aggregation pattern already in
     this codebase.
- Auth: a Personal Access Token in the `Authorization` header raises limits; anonymous
  queries work for public data.

Deliverable: same exported signature `searchHashnode(keywords, {page, perPage})`, people
first, authors aggregated across matched posts, `metadata.lastSeen` from newest matched
post date.

### Phase B — Fix the `hn-` id prefix collision

Rename to `hnode-{username}` (collides with `src/lib/sources/hn.ts` today).

### Phase C — Env documentation

Add `HASHNODE_API_KEY` to `.env.example`.

## Risks

| Risk                                                | Likelihood | Impact | Mitigation                                                                             |
| --------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------- |
| New API schema drift                                | Medium     | Low    | Keep the existing degrade-to-`[]` wrapper                                              |
| Post-search recall is worse than a real user search | Medium     | Medium | Accept — same tradeoff as Lobsters/HF author aggregation; document in connector header |
| Rate limits on anonymous queries                    | Medium     | Low    | 5-min search cache in `search.ts`; optional PAT                                        |

## Rollback plan

No migrations. The source already behaves as "off" (returns `[]`); reverting the migration
restores exactly today's dormant behavior.
