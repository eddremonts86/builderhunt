# Plan: Product Hunt Integration

> **Status**: `implemented` — wired but dormant until a token is provisioned
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Greenfield connector. Closest in-repo analogs: token-gated GraphQL
> pattern from `src/lib/sources/sourcehut.ts` + author-aggregation pattern from
> `src/lib/sources/huggingface.ts`. Requires an operator-provisioned `PRODUCTHUNT_TOKEN`
> before it returns anything.

## Phases (dependency order)

### Phase 0 — Token + schema verification (30 min, before any code)

Create a PH API application, obtain a Developer Token, and introspect the v2 schema to
confirm: `topics(query:)` argument, `posts(topic:, order:)` arguments, and which identity
fields exist on the maker/User type (`gitHubUsername` availability determines metadata).
The spec's queries are written from documented behavior but MUST be re-verified — the v2
API has changed field availability before.

### Phase 1 — Connector

`src/lib/sources/producthunt.ts` exporting
`searchProductHunt(keywords, { page, perPage })`:

1. Short-circuit `[]` when `env.PRODUCTHUNT_TOKEN` is unset (sourcehut pattern).
2. `gql` helper: POST to `https://api.producthunt.com/v2/api/graphql`, bearer token,
   try/catch + GraphQL-errors -> `null` (never throw — `search.ts` uses `Promise.all`).
3. Keyword -> topic slug (`topics(first:1, query:$q)` per keyword, first hit wins; also
   try the raw keyword as a slug), then `posts(first:20, topic:$slug, order:VOTES)` with
   makers, votes, topics, createdAt.
4. Aggregate makers across posts (huggingface `aggregateAuthor` pattern); people first,
   optional post repo-cards second; sort makers by total votes; slice by page/perPage.

### Phase 2 — Env

`PRODUCTHUNT_TOKEN` optional in `src/shared/lib/env.ts`; documented line in `.env.example`.

### Phase 3 — Registration

`producthunt` in `SourceName`; import + gate in `src/lib/search.ts`.

### Phase 4 — UI

Pill (opt-in), `SOURCE_META.producthunt` in `SearchPage.tsx` + `PersonResultCard.tsx`,
`ProductHuntIcon` in `BrandIcons.tsx`, `.badge-producthunt` in `globals.css`.

### Phase 5 — Scoring

`producthunt` branch in `src/lib/score.ts`: log bonus on `metadata.bestVotes` (cap 10).
`metadata.lastSeen` (newest launch) makes default recency scoring work.

## Risks

| Risk                                  | Likelihood | Impact | Mitigation                                                       |
| ------------------------------------- | ---------- | ------ | ---------------------------------------------------------------- |
| No free-text search in API v2         | Certain    | Medium | Topic-slug strategy; honest empty result for unmappable keywords |
| Complexity-based rate limit           | Medium     | Low    | 5-min search cache; opt-in pill; 2 queries/search                |
| Token expiry / revocation in prod     | Medium     | Low    | Connector degrades to `[]` on 401; log a warn line               |
| Schema drift on maker identity fields | Medium     | Low    | Phase 0 introspection gate before implementation                 |

## Rollback plan

No migrations. Unset `PRODUCTHUNT_TOKEN` to silence the source instantly; remove the pill/
gate to remove it from the product.
