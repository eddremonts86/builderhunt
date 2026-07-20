# Tasks: Product Hunt Integration

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Nothing exists yet. Requires a `PRODUCTHUNT_TOKEN` (official API,
> auth mandatory). Execute top-to-bottom.

- [ ] **Provision token and verify the v2 schema**
  - Files: none (operator step + scratch queries)
  - Do: create an app at api.producthunt.com/v2/docs, copy the Developer Token; run an
    introspection query confirming `topics(query:)`, `posts(topic:, order:)`, and the
    maker identity fields (`twitterUsername`, and whether `gitHubUsername` exists on the
    maker type). Record findings as comments in the connector header.
  - Verify: `curl -X POST https://api.producthunt.com/v2/api/graphql -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{"query":"{ topics(first:1, query: \"developer tools\") { nodes { slug } } }"}'`
    returns a slug.

- [ ] **Add `PRODUCTHUNT_TOKEN` env var**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: `PRODUCTHUNT_TOKEN: z.string().optional()` in the zod schema; add
    `PRODUCTHUNT_TOKEN=` to `.env.example` under "External Source API Tokens" (comment:
    REQUIRED for the Product Hunt source; Developer Token from api.producthunt.com).
  - Verify: `pnpm tsc --noEmit` passes; `grep PRODUCTHUNT_TOKEN .env.example` prints the line.

- [ ] **Create the Product Hunt connector**
  - Files: `src/lib/sources/producthunt.ts` (new)
  - Do: export `searchProductHunt(keywords: string[], options: { page?: number; perPage?: number } = {}): Promise<RawBuilder[]>`.
    Return `[]` immediately when `env.PRODUCTHUNT_TOKEN` is unset (copy the token gate +
    `gql<T>()` helper shape from `src/lib/sources/sourcehut.ts`, endpoint
    `https://api.producthunt.com/v2/api/graphql`, `Authorization: Bearer`). Flow:
    keyword -> `topics(first:1, query:$q)` slug -> `posts(first:20, topic:$slug, order:VOTES)`
    with makers/votesCount/topics/createdAt -> aggregate makers across posts (pattern:
    `aggregateAuthor` in `src/lib/sources/huggingface.ts`) -> map per the spec
    (`id: ph-{userId}`, votes total as `followersCount`, `metadata.lastSeen` from newest
    launch, launches sample in metadata) -> makers first, optional `kind:'repo'` post
    cards second -> sort by total votes -> slice by page/perPage. All failure modes
    (401/429/GraphQL errors/network) return `[]`/`null` — never throw.
  - Verify: with the token in `.env`, a scratch call `searchProductHunt(['developer tools'])`
    prints maker builders; with the token removed it returns `[]` with zero requests.

- [ ] **Register the source type + pipeline gate**
  - Files: `src/lib/sources/types.ts`, `src/lib/search.ts`
  - Do: add `'producthunt'` to `SourceName`; import `searchProductHunt` and add
    `if (sources.includes('producthunt')) tasks.push(searchProductHunt(keywords, { page, perPage }))`.
  - Verify: search API with `sources: ['producthunt']` returns makers (token set) and `[]`
    contribution (token unset) — other sources unaffected in both cases.

- [ ] **UI pill, icon, badge**
  - Files: `src/modules/search/components/SearchPage.tsx`,
    `src/modules/search/components/PersonResultCard.tsx`,
    `src/modules/landing/components/BrandIcons.tsx`, `src/shared/styles/globals.css`
  - Do: add `'producthunt'` to the `Builder.source` union and `ALL_SOURCES` (opt-in, NOT
    default-active); `SOURCE_META.producthunt = { label: 'Product Hunt', color: 'badge-producthunt', Icon: ProductHuntIcon }`
    in both components; `ProductHuntIcon` inline SVG in `BrandIcons.tsx`;
    `.badge-producthunt { background: rgba(218, 85, 47, 0.08); color: #c2410c; border-color: rgba(218, 85, 47, 0.15); }`.
  - Verify: pill renders, toggling it on adds/removes PH cards with the badge and icon.

- [ ] **Scoring branch**
  - Files: `src/lib/score.ts`
  - Do: add `else if (source === 'producthunt') { const best = (metadata.bestVotes as number | undefined) ?? 0; if (best > 0) score += Math.min(Math.log1p(best) * 1.2, 10) }`
    (comment: total votes already in `followersCount`; this rewards a breakout launch;
    recency comes from `metadata.lastSeen` via the default branch).
  - Verify: a maker with `bestVotes: 1200` scores ~8-10 points above an otherwise-equal
    maker with `bestVotes: 0` (unit assertion or manual log).
