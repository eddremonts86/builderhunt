# Project Hygiene — Real GitHub Signals (tasks)

> **Status**: `implemented — GitHub fetch path needs a real GITHUB_TOKEN to verify at scale`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: All 4 phases built and verified 2026-07-25. `GITHUB_TOKEN` is unset in
> this local dev environment, so the missing-token degrade path (503 → card falls back to
> the heuristic estimate) was live-verified end to end instead of the populated-data path;
> the underlying GitHub REST API call shapes (repos/issues/contents/workflows) were
> independently confirmed correct via direct `curl` against real GitHub endpoints before
> writing the fetcher, and all pure aggregation logic is fixture-tested. Whoever provisions
> a real token should do one live pass against a real tracked GitHub builder to confirm the
> populated-data path end to end.

## Delivered (v1)

- [x] **Hygiene scoring + grade helpers**
  - Files: `src/shared/lib/hygiene.ts`, `src/shared/lib/hygiene.test.ts`
  - Done: `computeHygiene` (30/30/20/20 weighting), `hygieneGrade`, `RepoSignals`/`ProjectHygiene` types.
- [x] **Hygiene profile card**
  - Files: `src/shared/components/HygieneCard.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Done: score ring, four metric tiles, checklist; computed client-side from estimated signals.

## Phase 1 — Deterministic fallback

- [x] **Seed the estimator**
  - Files: `src/shared/lib/hygiene.ts`, `src/shared/lib/hygiene.test.ts`
  - Do: replaced every `Math.random()` in `estimateRepoSignalsFromBuilder` with a `stableHash`/
    `seededRange` pair (djb2-style string hash) seeded by `username:language:followers:repoName`.
    Added `username` as an optional field on the function's input (threaded through from
    `BuilderProfilePage.tsx`) since it wasn't part of the original signature.
  - Verify: `pnpm vitest run src/shared/lib/hygiene.test.ts` — 22/22 passing, including two new
    tests asserting identical inputs produce byte-identical signals across calls.

## Phase 2 — Real signal fetcher

- [x] **Pure aggregation helpers**
  - Files: `src/lib/github/repo-signals.ts`, `src/lib/github/repo-signals.test.ts`
  - Do: `issuesToSignals` (filters `pull_request` rows, open/closed counts, `averageCloseDays`),
    `docsFromRootListing` (case-insensitive README/CONTRIBUTING/LICENSE, plus the British
    "licence" spelling), `selectReposForSignals` (non-fork, size > 0, top 5 by stars).
  - Verify: `pnpm vitest run src/lib/github/repo-signals.test.ts` — 12/12 passing against fixture
    payloads (empty issues, PR-only lists, forks, empty repos, >5 repos).
- [x] **Fetch pipeline**
  - Files: `src/lib/github/repo-signals.ts`
  - Do: `fetchRepoSignals(username)` — repo list, then per repo (in parallel):
    `issues?state=all&per_page=100`, root `contents/` listing, `.github/workflows` existence
    check. Exactly 1 + 5×3 = 16 requests worst case. `GitHubTokenMissingError`/
    `GitHubRateLimitedError` thrown for those specific conditions.
  - Verify: field shapes (`fork`, `size`, `stargazers_count`, `pushed_at`, issue `pull_request`/
    `state`/`closed_at`, contents `name`, workflows 404) all independently confirmed via live
    `curl` against `api.github.com` (real `octocat/Spoon-Knife` data) before writing the
    fetcher — not guessed from docs. The fetcher itself requires `GITHUB_TOKEN` (unset
    locally) to run past the auth gate; see the plan-level reality check above.

## Phase 3 — Endpoint + persistence

- [x] **Envelope schema**
  - Files: `src/shared/lib/hygiene.ts`
  - Do: added `repoSignalsSchema`, `projectHygieneSchema`, `projectHygieneEnvelopeSchema`
    (`{ hygiene, signals (≤5), computedAt, version: z.literal(1) }`).
  - Verify: `pnpm vitest run src/shared/lib/hygiene.test.ts` — round-trip parse test passes;
    a 6th signal correctly fails the `.max(5)` constraint.
- [x] **Hygiene endpoint**
  - Files: `src/routes/api/builders/$builderId/hygiene.ts`,
    `src/shared/lib/repositories/organization-builders.ts` (new `setOrganizationBuilderHygiene`,
    mirroring `setOrganizationBuilderEnrichment`'s `organization_builders.privateMetadata` pattern)
  - Do: GET implementing the spec's steps — ownership check via `findOrganizationBuilderByIdentity`
    (404 if not tracked in the caller's org); non-GitHub source → `{ estimated: true }`; 15-day
    freshness on `privateMetadata.projectHygiene`; `rateLimit('hygiene', userId, 10, 3600)`;
    missing token / rate-limited → 503; zero repos → `{ estimated: true }` (not persisted);
    else compute + persist the envelope, return with `cached: false`.
  - Verify: **live-verified end to end** in the browser against a real tracked GitHub builder —
    confirmed the route resolves ownership correctly (not a 404), detects the GitHub source,
    attempts the real fetch, and returns the exact expected `{"error":"github_token_missing"}`
    body at `503` (network tab, both request and response body inspected). The
    populated-data/cached-envelope/rate-limit paths are implemented per spec but need a real
    `GITHUB_TOKEN` to exercise — flagged rather than faked.

## Phase 4 — Card upgrade

- [x] **Fetch + provenance rendering**
  - Files: `src/shared/components/HygieneCard.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`
    (now passes `builderId`/`source` in addition to the existing `builder` prop)
  - Do: for GitHub builders, fetches the endpoint after mount (loading state on the metric
    tiles); a real envelope feeds the existing gauges, sets the caption to
    "From {n} public repos · {relative date}", and renders a per-repo mini-table (name, close
    rate, docs check, CI check) below the checklist; `estimated`/any fetch error falls back to
    the existing heuristic with the caption "Estimated from profile signals — not real repo
    data". All existing `data-testid`s (`hygiene-card`, `hygiene-score-ring`) kept unchanged.
  - Verify: **live-verified in the browser** — screenshot-confirmed clean rendering on a real
    GitHub builder profile in dark mode: score ring, "Average" grade, correct estimated-mode
    caption (missing-token fallback), all four metric tiles, and the checklist, with no layout
    shift or console errors. `pnpm tsc --noEmit`/`pnpm eslint .` clean (0 errors);
    `pnpm vitest run` 2022/2022 passing (16 new tests, no regressions).
