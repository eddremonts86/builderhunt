# Plan: GitLab Integration

## Goal recap

Index developers from GitLab.com alongside GitHub, doubling the addressable market and capturing the EU/enterprise OSS segment. Pattern is nearly identical to the existing GitHub integration.

## Why this is the top pick

Three reasons:

1. **Largest missing market.** GitHub + GitLab = ~95% of public OSS code. Without GitLab, we miss 30-50% of builders in many queries.
2. **Same shape, low effort.** The API patterns mirror GitHub's. `RawBuilder` shape fits. Effort: ~1.5 days.
3. **High-signal EU angle.** GitLab is bigger in Europe and in enterprise. Adding it adds a demographic BuilderHunt was missing.

## Phases

### Phase 0: Research (done in plan)

Confirmed:
- API: `https://gitlab.com/api/v4/`, REST + GraphQL
- Auth optional: 2000/h unauth, 6000/h with token
- Key endpoints: `/search?scope=users`, `/search?scope=projects`, `/users/:id`, `/users/:id/projects`
- Docs: https://docs.gitlab.com/api/users/

**Critical finding**: GitLab's free API does NOT expose:
- `followers_count` on users
- `stargazers_count` on projects (only `forks_count` and `open_issues_count`)

This is a real signal gap. We need a different scoring approach for GitLab.

### Phase 1: Data model

No schema changes. Use `source: 'gitlab'`.

### Phase 2: New source file

`src/lib/sources/gitlab.ts` — same pattern as `github.ts`. Two functions (`searchGitLabUsers`, `searchGitLabProjects`), exported `searchGitLab` that runs both in parallel.

**Scoring quirk**: since `followersCount` is undefined, GitLab results rely on bio/repo match + recency. Document this in `score.ts` so the algorithm knows.

### Phase 3: Pipeline integration

Add to `src/lib/search.ts`, add `'gitlab'` to the `Source` type, add GitLab to the default active sources. Add `GitLabIcon` to `BrandIcons.tsx`.

### Phase 4: UI

- New pill in the source filter row
- New `.badge-gitlab` in CSS
- Tabs (People/Resources) work as before; GitLab repos show up in Resources

### Phase 5: Verification

- Manual: search with GitLab on/off, save search, log activity
- Automated: Playwright test for toggle behavior
- Performance: cache GitLab results, respect 429

### Phase 6: Rollout

Soft launch with monitoring. Track dismiss rate (target < 50%) and click-through (target within 20% of GitHub).

## Dependency graph

```
Phase 0 (research) ──> Phase 2 (source) ──> Phase 3 (pipeline) ──> Phase 4 (UI) ──> Phase 5 (verify) ──> Phase 6 (rollout)
                       Phase 1 (brand)  ──┘
```

All phases after 0 can run sequentially in ~1.5 days.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Rate limiting aggressive** | Medium | Medium | Cache 5min, optional token for 6000/h, backoff on 429 |
| **Missing followers/stars** | High | Medium | Use bio match + recency as primary signal; document quirk |
| **Same person on GitHub + GitLab** | Medium | Low | Dedup by email (v2). For v1, show both — the dedup can dedup the display later |
| **Self-hosted GitLab confusion** | Low | Low | Document clearly: only gitlab.com in v1 |
| **Quality lower than GitHub** | Medium | Medium | Soft launch with dismiss rate monitoring; auto-disable if > 50% dismiss |

## Rollback plan

- Feature flag: `ENABLE_GITLAB=false` in env
- If data quality is poor, hide the source from the UI without removing the integration
- No migrations to revert

## What this is NOT

- **Not GitLab CI / pipelines.** Out of scope.
- **Not self-hosted.** Public SaaS only.
- **Not MRs / issues / snippets.** Just users and projects.
- **Not a deep social graph.** No followers/following import (API doesn't expose).

## What this enables (downstream)

Once GitLab works:
1. **Cross-source dedup by email** — same person on GitHub + GitLab shown once
2. **Self-hosted GitLab** (v2) — for enterprise customers
3. **Group/org pages** (v2) — show all builders in a GitLab group
4. **MR activity signal** (v2) — who has open MRs across the OSS ecosystem
