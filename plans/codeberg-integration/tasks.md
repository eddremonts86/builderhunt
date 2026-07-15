# Tasks: Codeberg (Gitea) Integration

> **Note: deferred** until GitLab integration ships and validates the "second forge" demand.

## Phase 0 — Research

- [ ] Test Gitea API at `https://codeberg.org/api/v1/` (it should work as a Gitea instance)
- [ ] Check rate limits and ToS

## Phase 1 — Data model

- [ ] No schema changes; `source: 'codeberg'`

## Phase 2 — Source

- [ ] New file `src/lib/sources/codeberg.ts`
- [ ] `searchCodebergUsers(keywords, token?)`:
  - `GET /users/search?q={query}&limit=20`
  - Map to `RawBuilder` with `kind: 'person'`
  - Source: 'codeberg'
- [ ] `searchCodebergRepos(keywords, token?)`:
  - `GET /repos/search?q={query}&limit=20`
  - Map to `RawBuilder` with `kind: 'repo'`
- [ ] `searchCodeberg(keywords, token?)`: combine

## Phase 3 — Wire

- [ ] Add `CODEBERG_TOKEN` to env (optional)
- [ ] Add to `search.ts`, `Source` type, default active sources (off by default)
- [ ] Add `CodebergIcon` to `BrandIcons.tsx` (use Gitea icon — teal)
- [ ] Add `.badge-codeberg` to globals.css

## Phase 4 — Scoring

- [ ] Bio match (×10)
- [ ] Followers count (Gitea exposes it!)
- [ ] Repo stars (Gitea exposes them!)
- [ ] Recency of last commit (×5)

## Phase 5 — Verification

- [ ] Manual: search "rust" → see Codeberg users
- [ ] Performance: < 500ms (Gitea is fast)
- [ ] Test with `?limit=20` pagination

## Estimated effort

**S-M (1-2 días)**. Pattern is essentially a clone of GitHub integration with a different base URL.
