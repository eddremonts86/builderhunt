# Tasks: Codeberg (Gitea) Integration

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Everything shipped, including `.env.example` documentation of the two
> Codeberg env vars (2026-07-25).

## Delivered

- [x] **Create Codeberg connector** — Done: `src/lib/sources/codeberg.ts`
      (`searchCodeberg(keywords, {page, perPage})`; `GET /users/search` + `GET /repos/search`
      in parallel; public/non-restricted/non-archived filters; errors return `[]`).
- [x] **Configurable Gitea base URL** — Done: `CODEBERG_API_URL` in
      `src/shared/lib/env.ts`, consumed as `CB_BASE` in `codeberg.ts` (works for self-hosted
      Gitea/Forgejo).
- [x] **Optional token** — Done: `CODEBERG_TOKEN` in `src/shared/lib/env.ts`, sent as
      `Authorization: token ...`.
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `codeberg` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **UI source pill + metadata** — Done: `ALL_SOURCES` + `SOURCE_META.codeberg` in
      `SearchPage.tsx` (opt-in); `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `CodebergIcon` in `BrandIcons.tsx`; `.badge-codeberg`
      in `src/shared/styles/globals.css`.
- [x] **Scoring** — Done: `codeberg` branch in `src/lib/score.ts` (real followers, star and
      fork bonuses).

## Remaining

- [x] **Document `CODEBERG_API_URL` and `CODEBERG_TOKEN` in `.env.example`**
  - Files: `.env.example`
  - Do: add both under "External Source API Tokens":
    `CODEBERG_API_URL=` (comment: defaults to `https://codeberg.org/api/v1`; point at any
    Gitea/Forgejo instance) and `CODEBERG_TOKEN=` (comment: optional, raises rate limit;
    from codeberg.org Settings > Applications).
  - Verify: `grep CODEBERG .env.example` prints both documented lines.
  - **Done.** Confirmed the default URL against `codeberg.ts`'s actual fallback
    (`env.CODEBERG_API_URL ?? 'https://codeberg.org/api/v1'`) before documenting it as fact.
