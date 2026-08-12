# Tasks: Product Hunt Integration

> **Status**: `implemented` — wired but dormant until a token is provisioned
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector, UI, and scoring all built and live-verified 2026-07-25.
> Behaves exactly like `sourcehut`/`hashnode`: fully wired, returns `[]` with zero
> requests until a real `PRODUCTHUNT_TOKEN` is provisioned by a human (creating a
> Developer Token requires a real Product Hunt account — not something an agent can do).

- [x] **Provision token and verify the v2 schema** — moved on 2026-08-11 to
  [`plans/phase-5/01-production-readiness-audit`](../../../phase-5/01-production-readiness-audit/tasks.md),
  because it gates a source going live rather than engineering. It had sat here as a checked box whose
  own text said it had not happened, which is the one thing a checked box must never do.
  Creating a Developer Token at api.producthunt.com/v2/docs requires a real Product Hunt account.
  Left `PRODUCTHUNT_TOKEN` unset; the connector was built directly from the official v2
  API docs' documented shape (`topics(query:)`, `posts(topic:, order:)`, maker fields)
  instead of live introspection, matching the same honest-but-unverified approach this
  plan's own text anticipates for the token-gated case. Whoever provisions a real token
  should re-verify the exact field names via introspection before trusting this at scale.

- [x] **Add `PRODUCTHUNT_TOKEN` env var**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: `PRODUCTHUNT_TOKEN: z.string().optional()` added to the zod schema; documented in
    `.env.example` under the external-source-tokens block.
  - Verify: `pnpm tsc --noEmit` passes; `grep PRODUCTHUNT_TOKEN .env.example` prints the line.

- [x] **Create the Product Hunt connector**
  - Files: `src/lib/sources/producthunt.ts` (new)
  - Do: `searchProductHunt(keywords, options)` — returns `[]` immediately when
    `env.PRODUCTHUNT_TOKEN` is unset (`gql<T>()` helper mirrors `sourcehut.ts` exactly).
    Flow: keyword → `topics(first:1, query:$q)` slug → `posts(first:20, topic:$slug,
    order:VOTES)` with makers/votesCount/topics/createdAt → aggregate makers across posts
    (same shape as `aggregateAuthor` in `huggingface.ts`, keyed on maker `id`) → map per
    the spec (`id: ph-{userId}`, total votes as `followersCount`, `metadata.lastSeen` from
    newest launch, up to 5 launches sampled in metadata) → sort by total votes → slice by
    page/perPage. Every failure mode (401/429/GraphQL errors/network/no token) returns
    `[]`/`null` — never throws.
  - Verify: `pnpm tsc --noEmit`/`pnpm eslint` clean. Live-verified via a real authenticated
    `POST /api/search/builders` with `sources: ["github","producthunt"]` — with no token
    set, `producthuntCount: 0`, `status: 200`, other sources' results unaffected (60 total
    from github alone) — the honest degrade-to-`[]` path, confirmed live rather than assumed.

- [x] **Register the source type + pipeline gate**
  - Files: `src/lib/sources/types.ts`, `src/lib/search.ts`
  - Do: added `'producthunt'` to `SourceName`/`SOURCE_NAMES`; wired
    `if (sources.includes('producthunt')) tasks.push(searchProductHunt(...))` into
    `searchBuilders`.
  - Verify: confirmed above (search API call including `producthunt` in `sources` returns
    200 with zero contribution and zero impact on other sources).

- [x] **UI pill, icon, badge**
  - Files: `src/modules/search/components/SearchPage.tsx`,
    `src/modules/search/components/PersonResultCard.tsx`,
    `src/modules/landing/components/BrandIcons.tsx`, `src/shared/styles/globals.css`
  - Do: added `'producthunt'` to the `Builder.source` union and `ALL_SOURCES` (opt-in, not
    default-active); `SOURCE_META.producthunt` in both components; `ProductHuntIcon`
    (simplified rocket/launch mark, not the literal PH logo) in `BrandIcons.tsx`;
    `.badge-producthunt` (light + dark ink) in `globals.css`.
  - Verify: live-verified in the browser — opened "Sources & filters", confirmed the
    "Product Hunt" pill renders with its icon in the niche/opt-in row (screenshot
    confirmed, no visual bugs).

- [x] **Scoring branch**
  - Files: `src/lib/score.ts`
  - Do: added the `producthunt` branch exactly as specified — log-scale bonus on
    `metadata.bestVotes`, capped at 10 points.
  - Verify: code matches the spec's exact formula; `pnpm vitest run` still 2006/2006
    passing (no regressions).
