# Tasks: GitLab Integration

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector, pipeline wiring, UI pill, badge, icon, scoring branch, env var,
> token-gated search, and `.env.example` docs all delivered (2026-07-25).

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

- [x] **Use `GITLAB_TOKEN` to unlock authenticated user/project search**
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
  - **Done.** Added `fetchUserSearchResults`/`fetchProjectSearchResults` (both return `[]`
    instantly with no token — safe to call unconditionally) and
    `userSearchResultToPersonBuilder` exactly as specified (`gl-user-{username}` id,
    `followersCount: undefined` — GitLab exposes no follower count on any endpoint, tokenless
    or not, so score already falls back to recency/quality for this source). Restructured
    `searchGitLab` to run the token-gated directory search in parallel with the existing
    tokenless top-500 sampling, then merge with a `seen`-id dedup (token-search results
    first, since they're a real precise match rather than a star-sampled guess) so a person
    matching both paths isn't shown twice.
    - Live-verified the tokenless path with a real network call (no `GITLAB_TOKEN`
      configured in this environment): `searchGitLab(['react'])` still returns the expected
      owner-aggregated person cards, unchanged from before this task. Could not live-verify
      the token-gated path against a real GitLab account (no `GITLAB_TOKEN` available in this
      session) — verified by code review instead: both new fetch functions mirror the
      existing `fetchProjectsPage`'s exact try/catch/`.ok`-check/header shape, and the dedup
      logic degrades to a pure pass-through (identical output to before) whenever the two
      token-gated arrays are empty, which is exactly the "token unset → unchanged" case tsc
      and a real network call both confirmed.
    - `pnpm tsc --noEmit`/`pnpm eslint` clean; full `pnpm vitest run` (2004/2004, this
      connector has no dedicated test file — matches the established convention that none of
      the ~10 external source connectors in `src/lib/sources/` have unit tests today).

- [x] **Document `GITLAB_TOKEN` in `.env.example`**
  - Files: `.env.example`
  - Do: add `GITLAB_TOKEN=` under the "External Source API Tokens" section with a comment
    (raises quota 2000/h to 6000/h and unlocks user search; from gitlab.com Settings >
    Access Tokens, `read_api` scope).
  - Verify: `grep GITLAB_TOKEN .env.example` prints the documented line.
  - **Done.** Added under "External Source API Tokens," matching the existing
    `GITHUB_TOKEN`/`REDDIT_CLIENT_ID` comment style.
