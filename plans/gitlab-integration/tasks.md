# Tasks: GitLab Integration

## Phase 0 — Read first

- [ ] `src/lib/sources/github.ts` — pattern to follow
- [ ] `src/lib/score.ts` — how scoring works, how to add source-specific quirks
- [ ] `src/lib/dedup.ts` — current dedup logic, plan for cross-source merge
- [ ] `src/modules/landing/components/BrandIcons.tsx` — add GitLab icon

## Phase 1 — Data model

- [ ] **No schema changes.** Use the same `builders` table; rely on `source: 'gitlab'`.

## Phase 2 — New source: `src/lib/sources/gitlab.ts`

- [ ] Create the file
- [ ] Add to `BuilderKind` type: `'person' | 'repo'`
- [ ] `searchGitLabUsers(query, token?)`:
  - `GET /search?scope=users&search={query}&per_page=20`
  - Map to `RawBuilder[]` with `kind: 'person'`, `source: 'gitlab'`
  - Use `user.id` for `sourceId`
  - Use `user.web_url` for `profileUrl` (already full URL)
  - `avatarUrl: user.avatar_url` (already full URL)
  - `metadata` includes: `createdAt`, `location`, `organization`, `jobTitle`, `publicProjects` (if available)
  - **`followersCount: undefined`** — not exposed by API
- [ ] `searchGitLabProjects(query, token?)`:
  - `GET /search?scope=projects&search={query}&per_page=20`
  - Map to `RawBuilder[]` with `kind: 'repo'`, `source: 'gitlab'`
  - `followersCount: project.star_count` (try first) or `project.forks_count` (fallback)
  - `topics: project.topics` (if any) or `project.tag_list` (legacy)
  - `metadata` includes: `stars`, `forks`, `issues`, `lastActivityAt`
- [ ] `searchGitLab(keywords, token?)`:
  - Run both in parallel via `Promise.all`
  - Combine: `[...users, ...projects]`
- [ ] Add `GITLAB_TOKEN` to `src/shared/lib/env.ts` (optional, increases rate limit)

## Phase 3 — Wire into the search pipeline

- [ ] Update `src/lib/search.ts` to include `searchGitHub`, `searchGitLab`, etc.
- [ ] Update `BuilderKind` union in `src/lib/search.ts` if needed
- [ ] Update `ALL_SOURCES` and `SOURCE_META` in `SearchPage.tsx`:
  - Add `'gitlab'` to the `Source` type
  - Add `SOURCE_META.gitlab = { label: 'GitLab', color: 'badge-gitlab', Icon: GitLabIcon }`
  - Add GitLab to the default active sources (4 → 5)

## Phase 4 — Brand icon

File: `src/modules/landing/components/BrandIcons.tsx`

- [ ] Add `GitLabIcon` (inline SVG, same pattern as `GithubIcon`)
- [ ] Color: `#FC6D26` (GitLab tanuki orange)

## Phase 5 — UI badge + scoring

- [ ] Add `.badge-gitlab` to `globals.css`:
  ```css
  .badge-gitlab { background: rgba(252, 109, 38, 0.12); color: #FC6D26; border-color: rgba(252, 109, 38, 0.2); }
  ```
- [ ] Update `src/lib/score.ts` to handle GitLab's missing `followersCount`:
  - If `followersCount === undefined` and `source === 'gitlab'`, fall back to a relevance score based on:
    - Bio keyword match (already in place)
    - Recency of `lastActivityAt` (if `kind === 'repo'`)
    - For users: just rely on the existing recency-based score
  - This is a **quirk**, not a hack: GitLab users have less social proof but are equally good builders

## Phase 6 — Verification

### Manual
- [ ] Anonymous: search "kubernetes" with GitLab enabled → see GitLab users in results
- [ ] Anonymous: search "kubernetes" with GitLab disabled → no GitLab results
- [ ] Logged in: save search with GitLab enabled → search has the `gitlab` source
- [ ] GitLab user card shows the orange badge and GitLab icon correctly

### Automated (Playwright)
- [ ] Toggle "GitLab" off → result count decreases
- [ ] Toggle "GitLab" on → result count increases
- [ ] GitLab cards have the `.badge-gitlab` class

### Performance
- [ ] GitLab endpoint < 400ms (rate-limit aware)
- [ ] Cache: in-memory LRU 5min, keyed by `(query, sources)`
- [ ] If 429 (rate limit), degrade gracefully to cached results

## Phase 7 — Rollout

- [ ] Soft launch: enable GitLab for all users by default
- [ ] Monitor: 7 days
- [ ] Track: % searches using GitLab, click-through rate vs GitHub, dismiss rate
- [ ] If dismiss rate > 50%, review scoring and data quality
- [ ] If GitLab proves valuable, add it to the popular queries on the landing page

## Edge cases to handle

- **Rate limit (429)**: back off exponentially, serve cached results if available
- **GitLab user with no public activity**: filter out (or show with "low activity" indicator)
- **Same person on GitHub + GitLab with same email**: dedup logic (deferred to v2, document in spec)
- **Private GitLab users**: not accessible via public API, skip
- **Self-hosted GitLab instances**: not in scope; document as future
- **Search returns 0 results from GitLab**: silently skip, don't error the whole request

## Dependencies

- Existing: `RawBuilder`, `search.ts`, `score.ts`, `dedup.ts`, `SearchPage`
- New: `GITLAB_TOKEN` env var (optional)
- Schema: no changes

## Estimated effort

| Phase | Effort |
|-------|--------|
| 2 — New source | S (4-6h) |
| 3 — Wire in | XS (1-2h) |
| 4 — Brand icon | XS (30min) |
| 5 — UI + scoring | S (2-3h) |
| 6 — Verification | S (2-3h) |
| **Total** | **~1.5 days** |
