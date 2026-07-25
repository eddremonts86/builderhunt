# Tasks: Bluesky Integration

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Nothing exists yet. Execute top-to-bottom; the feature is shippable
> after each checkpoint (connector -> pipeline -> UI -> scoring).

- [ ] **Create the Bluesky connector**
  - Files: `src/lib/sources/bluesky.ts` (new)
  - Do: export `searchBluesky(keywords: string[], options: { page?: number; perPage?: number } = {}): Promise<RawBuilder[]>`.
    Call `GET https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q={encodeURIComponent(keywords.join(' '))}&limit=25`
    (header `User-Agent: BuilderHunt/1.0 (bluesky source)`), then hydrate all DIDs in one
    `GET .../xrpc/app.bsky.actor.getProfiles?actors=...` call (repeat the `actors` param,
    max 25). Map per the spec's RawBuilder block (`id: bsky-{did}`, handle as username,
    bio hashtags as topics, `metadata.customDomainHandle`). Sort by followers desc, slice
    `(page-1)*perPage .. +perPage`. Wrap each fetch in try/catch: search failure -> `[]`,
    hydration failure -> return unhydrated actors (no followersCount). Empty/whitespace
    keywords -> `[]` (match `huggingface.ts` guard).
  - Verify: `curl 'https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=rust&limit=2'`
    returns actors; a temporary script calling `searchBluesky(['rust'])` prints mapped
    builders with `followersCount` populated.

- [ ] **Register the source type**
  - Files: `src/lib/sources/types.ts`
  - Do: add `'bluesky'` to the `SourceName` union.
  - Verify: `pnpm tsc --noEmit` (or `pnpm build`) passes.

- [ ] **Wire into the federated search**
  - Files: `src/lib/search.ts`
  - Do: `import { searchBluesky } from '~/lib/sources/bluesky'`; add
    `if (sources.includes('bluesky')) tasks.push(searchBluesky(keywords, { page, perPage }))`
    next to the other gates.
  - Verify: `POST /api/search` (or the search UI) with `sources: ['bluesky']` returns
    Bluesky results; with Bluesky offline (block the host) the same request still returns
    other sources' results.

- [ ] **Add the UI source pill**
  - Files: `src/modules/search/components/SearchPage.tsx`,
    `src/modules/search/components/PersonResultCard.tsx`
  - Do: add `'bluesky'` to the `Builder.source` union (line ~20) and to `ALL_SOURCES`
    (NOT `DEFAULT_ACTIVE_SOURCES`); add
    `SOURCE_META.bluesky = { label: 'Bluesky', color: 'badge-bluesky', Icon: BlueskyIcon }`
    in both files.
  - Verify: the pill row shows a 13th "Bluesky" pill, off by default; toggling it on and
    searching shows Bluesky cards with the badge.

- [ ] **Brand icon + badge CSS**
  - Files: `src/modules/landing/components/BrandIcons.tsx`,
    `src/shared/styles/globals.css`
  - Do: add `BlueskyIcon` (inline butterfly SVG, same props signature as `GithubIcon`);
    add `.badge-bluesky { background: rgba(0, 133, 255, 0.08); color: #0369a1; border-color: rgba(0, 133, 255, 0.15); }`
    next to the other `.badge-*` rules.
  - Verify: Bluesky cards render the butterfly icon and blue badge in both the pill row
    and result cards.

- [ ] **Scoring branch for custom-domain handles**
  - Files: `src/lib/score.ts`
  - Do: add `else if (source === 'bluesky') { if (metadata.customDomainHandle === true) score += 5 }`
    in the source-specific section (comment: custom domain = deliberate identity signal;
    followers/quality/topics ride the default paths; no lastSeen in v1 -> neutral recency).
  - Verify: two otherwise-equal mock builders differ by 5 points when one has
    `customDomainHandle: true` (quick unit assertion or manual log).
