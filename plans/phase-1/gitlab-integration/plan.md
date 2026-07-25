# Plan: GitLab Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: `src/lib/sources/gitlab.ts` ships the top-starred-projects sampling
> strategy (unauth search API is impossible — 401). Wired into `src/lib/search.ts`, UI, and
> `src/lib/score.ts`. Remaining work is small: token-gated real search + env docs.

## Executed phases (record)

1. **Source file** — `src/lib/sources/gitlab.ts`: `searchGitLab(keywords, {page, perPage})`
   fetching top ~500 public projects by stars, client-side keyword filter, owner
   aggregation into person cards. All fetch errors swallowed to `[]`.
2. **Pipeline** — import + `sources.includes('gitlab')` gate in `src/lib/search.ts`;
   `gitlab` added to `SourceName` (`src/lib/sources/types.ts`).
3. **UI** — pill (opt-in), `SOURCE_META.gitlab`, `GitLabIcon`, `.badge-gitlab`.
4. **Scoring** — `gitlab` branch in `src/lib/score.ts` (log-fork bonus).
5. **Env** — optional `GITLAB_TOKEN` in `src/shared/lib/env.ts`.

## Remaining phases

### Phase A — Token-gated real search (the only functional gap)

When `GITLAB_TOKEN` is set, use the authenticated search API instead of the top-500 sample:
`GET /api/v4/search?scope=users&search={q}` and `?scope=projects`. Keep the sampling path
as the unauthenticated fallback. This keeps behavior identical for tokenless deploys and
dramatically improves recall for deploys with a token.

### Phase B — Env documentation

Add `GITLAB_TOKEN` to `.env.example` under the source-tokens section.

## Risks

| Risk                                                          | Likelihood | Impact | Mitigation                                                                   |
| ------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------- |
| Authed search-scope shape differs from `/projects` list shape | Medium     | Low    | Separate mapper for search results; keep existing mappers intact             |
| Quota exhaustion (6000/h authed)                              | Low        | Low    | Existing 5-min search cache in `search.ts`; connector returns `[]` on non-OK |
| Regression of unauth path                                     | Low        | Medium | Fallback branch untouched; verify both paths manually                        |

## Rollback plan

No migrations. Removing `'gitlab'` from `ALL_SOURCES` in `SearchPage.tsx` hides the source;
removing the `sources.includes('gitlab')` line in `search.ts` disables it entirely.
