# Feature: Codeberg (Gitea) Integration

> **Status**: `implemented` (verified 2026-07-28)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Fully functional connector at `src/lib/sources/codeberg.ts`, wired
> into `src/lib/search.ts`, UI, and `src/lib/score.ts`. `CODEBERG_API_URL` /
> `CODEBERG_TOKEN` exist in `src/shared/lib/env.ts` and both **are** documented in
> `.env.example` (that last gap closed 2026-07-25).

## Problem

Codeberg is the largest Gitea/Forgejo instance: EU-based, OSS-focused, popular with
developers who avoid GitHub. Its Gitea-standard API also works for any self-hosted
Gitea/Forgejo instance.

## Goal

Index Codeberg users and repositories as `RawBuilder` records alongside the other sources.

## Delivered

Shipped in `src/lib/sources/codeberg.ts`:

- Real search API (unlike GitLab, works unauthenticated):
  - `GET {CB_BASE}/users/search?q={q}&limit=20` — people, filtered to public non-restricted
    accounts; real `followers_count` (Gitea exposes it). `id: cb-{userId}`.
  - `GET {CB_BASE}/repos/search?q={q}&limit=20` — repos, filtered to non-private,
    non-archived; stars as `followersCount`. `id: cb-repo-{repoId}`.
- Base URL is configurable: `CODEBERG_API_URL` (defaults to
  `https://codeberg.org/api/v1`), so any self-hosted Gitea/Forgejo works — the "bonus" from
  the original spec was actually delivered.
- Optional `CODEBERG_TOKEN` sent as `Authorization: token ...` for higher rate limits.
- Registered in `src/lib/search.ts` and `SourceName` (`src/lib/sources/types.ts`).
- UI: opt-in pill in `ALL_SOURCES` + `SOURCE_META` (`SearchPage.tsx`), `CodebergIcon` in
  `BrandIcons.tsx`, `.badge-codeberg` in `src/shared/styles/globals.css`.
- Scoring: `codeberg` branch in `src/lib/score.ts` (honest follower counts + star/fork
  bonuses).
- All fetches wrapped in try/catch returning `[]` (required: `search.ts` uses `Promise.all`).

## Remaining gaps (real)

1. **`CODEBERG_API_URL` and `CODEBERG_TOKEN` are missing from `.env.example`** — the only
   documentation of these vars is the zod schema in `src/shared/lib/env.ts`.

## Non-goals (unchanged)

Multiple simultaneous Gitea instances (the env var points at exactly one); private repos;
org/team crawling.

## Success metrics

- Queries like "rust", "forgejo", "privacy" return Codeberg people with real follower
  counts; source pill toggling adds/removes the results.
