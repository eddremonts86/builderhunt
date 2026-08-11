# Tasks: Bluesky Integration

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Fully built and live-verified 2026-07-25 against the real, public,
> unauthenticated AppView — real people, real follower counts, no API key needed.

- [x] **Create the Bluesky connector**
  - Files: `src/lib/sources/bluesky.ts` (new)
  - Do: `searchBluesky(keywords, options)` calls
    `GET app.bsky.actor.searchActors?q=...&limit=25`, then hydrates all DIDs in one
    `GET app.bsky.actor.getProfiles?actors=...` batch call. Maps per the spec's RawBuilder
    block; sorts by followers desc; slices by page/perPage. Search failure → `[]`;
    hydration failure → returns unhydrated actors (no followersCount) rather than nothing;
    empty/whitespace keywords → `[]`.
  - Verify: live-verified via a real authenticated `POST /api/search/builders` call with
    `sources: ["bluesky"]` and keyword "rust" — returned real people (Rusty Foster,
    Rust Language, Rusty Lake, etc.) with real `followersCount` (16777, 10430, 5290...),
    real avatars, real bios, `customDomainHandle` correctly computed.

- [x] **Register the source type**
  - Files: `src/lib/sources/types.ts`
  - Do: added `'bluesky'` to `SourceName`/`SOURCE_NAMES`.
  - Verify: `pnpm tsc --noEmit` passes.

- [x] **Wire into the federated search**
  - Files: `src/lib/search.ts`
  - Do: imported `searchBluesky`; added the `sources.includes('bluesky')` gate.
  - Verify: confirmed live above — 200 response, real Bluesky results returned alongside
    (and without breaking) other sources.

- [x] **Add the UI source pill**
  - Files: `src/modules/search/components/SearchPage.tsx`,
    `src/modules/search/components/PersonResultCard.tsx`
  - Do: added `'bluesky'` to the `Builder.source` union and `ALL_SOURCES` (opt-in, not
    default-active); `SOURCE_META.bluesky` in both files.
  - Verify: live-verified in the browser — real search results render with the "Bluesky"
    badge, real avatars/bios/follower counts, screenshot-confirmed clean rendering in dark
    mode.

- [x] **Brand icon + badge CSS**
  - Files: `src/modules/landing/components/BrandIcons.tsx`,
    `src/shared/styles/globals.css`
  - Do: added `BlueskyIcon` (simplified butterfly mark) and `.badge-bluesky` (light + dark
    ink) matching the spec's brand-blue values.
  - Verify: confirmed visually in the live screenshot above — icon and badge render
    correctly.

- [x] **Scoring branch for custom-domain handles**
  - Files: `src/lib/score.ts`
  - Do: added the exact branch from the spec — `+5` when `metadata.customDomainHandle`.
  - Verify: `pnpm vitest run` 2006/2006 passing (no regressions); real search results above
    show custom-domain handles (e.g. `rust-lang.org`) scoring correctly.
