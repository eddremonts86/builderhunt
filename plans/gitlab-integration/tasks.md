# Tasks: GitLab Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector, pipeline wiring, UI pill, badge, icon, scoring branch, and
> env var all exist. Only token-gated search and `.env.example` docs remain.

## Delivered

- [x] **Create GitLab connector** — Done: `src/lib/sources/gitlab.ts`
      (`searchGitLab(keywords, {page, perPage})`, top-500-starred-projects sampling + owner
      aggregation; errors return `[]`).
- [x] **Register in federated search** — Done: `src/lib/search.ts` (import + gate),
      `gitlab` in `SourceName` union (`src/lib/sources/types.ts`).
- [x] **Add `GITLAB_TOKEN` env var** — Done: `src/shared/lib/env.ts` (optional).
- [x] **UI source pill + metadata** — Done: `ALL_SOURCES` + `SOURCE_META.gitlab` in
      `src/modules/search/components/SearchPage.tsx` (opt-in, not default-active);
      `SOURCE_META` in `src/modules/search/components/PersonResultCard.tsx`.
- [x] **Brand icon** — Done: `GitLabIcon` in `src/modules/landing/components/BrandIcons.tsx`.
- [x] **Badge CSS** — Done: `.badge-gitlab` in `src/shared/styles/globals.css`.
- [x] **Scoring quirk for missing followers** — Done: `gitlab` branch in `src/lib/score.ts`
      (total stars as `followersCount` proxy, fork bonus, `metadata.lastSeen` recency).

## Remaining

- [ ] **Use `GITLAB_TOKEN` to unlock authenticated user/project search**
  - Files: `src/lib/sources/gitlab.ts`
  - Do: when `env.GITLAB_TOKEN` is set, call
    `GET https://gitlab.com/api/v4/search?scope=users&search={q}&per_page=20` and
    `?scope=projects` (header `PRIVATE-TOKEN`), map users to `kind: 'person'`
    (`id: gl-user-{username}`, `followersCount: undefined` — score falls back to recency/
    quality) and projects through the existing `projectToRepoBuilder`. Keep the current
    top-500 sampling as the tokenless fallback. Wrap every fetch in try/catch returning `[]`.
  - Verify: with `GITLAB_TOKEN` set, search "kubernetes" with only the GitLab pill active
    returns user cards whose usernames are not owners of top-500-starred projects; with the
    token unset, results are unchanged from today.

- [ ] **Document `GITLAB_TOKEN` in `.env.example`**
  - Files: `.env.example`
  - Do: add `GITLAB_TOKEN=` under the "External Source API Tokens" section with a comment
    (raises quota 2000/h to 6000/h and unlocks user search; from gitlab.com Settings >
    Access Tokens, `read_api` scope).
  - Verify: `grep GITLAB_TOKEN .env.example` prints the documented line.
