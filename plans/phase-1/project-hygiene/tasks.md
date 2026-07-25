# Project Hygiene — Real GitHub Signals (tasks)

> **Status**: `partially-implemented` (v1 tasks checked; v2 tasks pending)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: `src/shared/lib/hygiene.ts` (+ `hygiene.test.ts`) and `src/shared/components/HygieneCard.tsx` are live; no endpoint, no persistence, no real GitHub fetching exists yet.

## Delivered (v1)

- [x] **Hygiene scoring + grade helpers**
  - Files: `src/shared/lib/hygiene.ts`, `src/shared/lib/hygiene.test.ts`
  - Done: `computeHygiene` (30/30/20/20 weighting), `hygieneGrade`, `RepoSignals`/`ProjectHygiene` types.
- [x] **Hygiene profile card**
  - Files: `src/shared/components/HygieneCard.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Done: score ring, four metric tiles, checklist; computed client-side from estimated signals.

## Phase 1 — Deterministic fallback

- [ ] **Seed the estimator**
  - Files: `src/shared/lib/hygiene.ts`, `src/shared/lib/hygiene.test.ts`
  - Do: replace every `Math.random()` in `estimateRepoSignalsFromBuilder` with values from a
    small stable string-hash of `username + repoName` (pure helper in the same file). Keep
    output ranges identical.
  - Verify: `pnpm test hygiene` — new test asserts two calls with the same builder return identical signals.

## Phase 2 — Real signal fetcher

- [ ] **Pure aggregation helpers**
  - Files: `src/lib/github/repo-signals.ts`, `src/lib/github/repo-signals.test.ts`
  - Do: `issuesToSignals(issuesPayload)` (filter `pull_request` rows, open/closed counts,
    `averageCloseDays`), `docsFromRootListing(entries)` (case-insensitive README/CONTRIBUTING/
    LICENSE), repo-selection filter (non-fork, size > 0, top 5 by stars). Pure, fixture-tested.
  - Verify: `pnpm test repo-signals` green against fixture payloads (incl. empty issues, PR-only lists).
- [ ] **Fetch pipeline**
  - Files: `src/lib/github/repo-signals.ts`
  - Do: `fetchRepoSignals(username)` — repos list, then per repo: issues page
    (`state=all&per_page=100`), root contents listing, `.github/workflows` existence check
    (404 → false). ≤ 16 requests total; `GITHUB_TOKEN` from env; typed errors
    `GitHubTokenMissingError` / `GitHubRateLimitedError`.
  - Verify: manual script run against a real username returns ≤ 5 `RepoSignals` rows with plausible values.

## Phase 3 — Endpoint + persistence

- [ ] **Envelope schema**
  - Files: `src/shared/lib/hygiene.ts`
  - Do: add zod `repoSignalsSchema`, `projectHygieneSchema`, and
    `projectHygieneEnvelopeSchema` (`{ hygiene, signals (≤5), computedAt ISO, version: z.literal(1) }`)
    matching the existing interfaces.
  - Verify: `pnpm test hygiene` — round-trip parse of a `computeHygiene` result inside the envelope.
- [ ] **Hygiene endpoint**
  - Files: `src/routes/api/builders/$builderId/hygiene.ts`
  - Do: GET implementing the spec's 7 steps — ownership check; non-GitHub → `{ estimated: true }`;
    15-day freshness on `metadata.projectHygiene`; missing token → 503; `rateLimit('hygiene', userId, 10, 3600)`;
    fetch → zero repos → `{ estimated: true }` (not persisted); else envelope +
    `jsonb_set(metadata, '{projectHygiene}', …)`.
  - Verify: curl on a tracked GitHub builder returns real signals; second call `cached: true`; HN builder returns `estimated: true`; other user's row → 404/403.

## Phase 4 — Card upgrade

- [ ] **Fetch + provenance rendering**
  - Files: `src/shared/components/HygieneCard.tsx`
  - Do: for GitHub builders fetch the endpoint after mount (skeleton on numbers while
    loading); real envelope → existing gauges fed by `hygiene`, caption
    "From {n} public repos · {relative date}", per-repo mini-table (name, close rate, docs,
    CI) under the checklist; `estimated`/error → current heuristic with caption
    "Estimated from profile signals — not real repo data". Keep existing `data-testid`s.
  - Verify: UI check on a GitHub builder (real caption + table) and a non-GitHub builder (estimated caption); no layout shift on the loading path.
