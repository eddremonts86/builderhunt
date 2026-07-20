# Tasks: SourceHut Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped. Remaining: `.env.example` docs and an
> optional repo-search extension.

## Delivered

- [x] **GraphQL client + user search** — Done: `src/lib/sources/sourcehut.ts`
      (`searchSourceHut(keywords, {page, perPage})` against `https://meta.sr.ht/query`;
      returns `[]` without `SOURCEHUT_TOKEN` or on any error).
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `sourcehut` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **Add `SOURCEHUT_TOKEN` env var** — Done: `src/shared/lib/env.ts` (optional).
- [x] **UI source pill + metadata** — Done: `ALL_SOURCES` + `SOURCE_META.sourcehut` in
      `SearchPage.tsx` (opt-in); `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `SourceHutIcon` in `BrandIcons.tsx`;
      `.badge-sourcehut` in `src/shared/styles/globals.css`.
- [x] **Scoring without followers** — Done: `sourcehut` branch in `src/lib/score.ts`
      (bio-length bonus; no follower data exists upstream).

## Remaining

- [ ] **Document `SOURCEHUT_TOKEN` in `.env.example`**
  - Files: `.env.example`
  - Do: add `SOURCEHUT_TOKEN=` under "External Source API Tokens" with a comment: REQUIRED
    for the SourceHut source to return anything (API 401s unauthenticated); create at
    meta.sr.ht > OAuth > personal access token.
  - Verify: `grep SOURCEHUT_TOKEN .env.example` prints the documented line.

- [ ] **(Optional) Emit repo results from git.sr.ht**
  - Files: `src/lib/sources/sourcehut.ts`
  - Do: with the same token, POST to `https://git.sr.ht/query` searching public
    repositories by keyword; map to `kind: 'repo'` (`id: sh-repo-{id}`,
    `followersCount: undefined`, `metadata.lastSeen` from `updated`). Keep person results
    first, then repos, sliced by `page`/`perPage` like other connectors. All errors -> `[]`.
  - Verify: with a token set, search a term matching a known sr.ht repo with only the
    SourceHut pill active; a repo card appears under the Resources tab.
