# Feature: GitLab Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector exists at `src/lib/sources/gitlab.ts` and is wired into
> `src/lib/search.ts`, the UI source pills (`src/modules/search/components/SearchPage.tsx`),
> and scoring (`src/lib/score.ts`). `GITLAB_TOKEN` exists in `src/shared/lib/env.ts` but is
> not documented in `.env.example`.

## Problem

BuilderHunt indexes developers from GitHub but originally ignored GitLab. GitLab hosts a
large developer population (especially EU and enterprise OSS) that is not on GitHub or has
parallel profiles there.

## Goal

Index GitLab.com (public SaaS instance) builders alongside the other sources, returning
`RawBuilder` records (`src/lib/sources/types.ts`) for both people (`kind: 'person'`) and
projects (`kind: 'repo'`).

## Delivered

Shipped in `src/lib/sources/gitlab.ts` (see the file header for the full rationale):

- **v1 strategy differs from this spec's original design for a real API reason**:
  GitLab's `/api/v4/search?scope=users|projects` returns **401 without auth**. The
  connector instead fetches the top ~500 public projects ordered by `star_count`
  (`GET /api/v4/projects?visibility=public&order_by=star_count`, 5 pages x 100), filters
  them client-side against the query (name, path, description, topics, namespace), and emits:
  - `kind: 'repo'` — matched projects (`id: gl-{projectId}`), stars as `followersCount`.
  - `kind: 'person'` — user-namespace owners aggregated across matched projects
    (`id: gl-user-{path}`), total stars as `followersCount` proxy. The original "followers
    not exposed" open question was resolved this way; group namespaces are skipped.
- Registered in `src/lib/search.ts` (`sources.includes('gitlab')`) and in the `SourceName`
  union in `src/lib/sources/types.ts`.
- UI: `gitlab` pill in `ALL_SOURCES` + `SOURCE_META` in `SearchPage.tsx` (**opt-in**, not in
  `DEFAULT_ACTIVE_SOURCES`), `GitLabIcon` in
  `src/modules/landing/components/BrandIcons.tsx`, `.badge-gitlab` in
  `src/shared/styles/globals.css`.
- Scoring: `gitlab` branch in `src/lib/score.ts` (fork bonus; recency via `metadata.lastSeen`).
- Failure containment: fetch errors are caught inside the connector and return `[]` —
  mandatory because `src/lib/search.ts` runs sources with `Promise.all` (a rejected source
  promise would fail the whole federated search).
- `GITLAB_TOKEN` (optional; raises quota 2000/h to 6000/h) in `src/shared/lib/env.ts`.

## Remaining gaps (real, cited from code)

1. **The token never unlocks real search.** `gitlab.ts` uses `GITLAB_TOKEN` only for quota.
   With a token, `/api/v4/search?scope=users&search={q}` works and returns far better
   matches than the top-500-projects sample. Promised originally, never built.
2. **Coverage is limited to top-starred projects.** Long-tail queries return nothing from
   GitLab; `page`/`perPage` only slice the pre-fetched sample (no real API pagination).
3. **`GITLAB_TOKEN` is missing from `.env.example`** (env documentation gap).

## Non-goals (unchanged)

Self-hosted GitLab instances; merge requests / issues / snippets; follower graph (the API
does not expose one).

## Success metrics

- Today: >=1 GitLab result on popular-stack queries (react, rust, kubernetes), which match
  top-starred project descriptions/topics.
- After gap #1 closes: GitLab result rate on saved searches comparable to Codeberg's.
