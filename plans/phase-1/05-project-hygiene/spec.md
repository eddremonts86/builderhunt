# Project Hygiene — Real GitHub Signals (spec)

> **Status**: `implemented` (v2 real repo signals shipped; the `GITHUB_TOKEN` degrade path is what
> was live-verified locally — see `tasks.md`)
> **Depends on**: nothing (deliberately **no AI** — this is GitHub REST API work; see "Why no AI" below)
> **Blocks**: nothing
> **Reality check (verified 2026-07-28)**: the fabrication this plan existed to remove is gone.
> `src/shared/lib/hygiene.ts` keeps the pure `computeHygiene(repos)` scoring (issue close rate 30% /
> resolution 30% / docs 20% / CI 20%), `hygieneGrade`, and `estimateRepoSignalsFromBuilder` — but the
> estimator is now seeded by a stable `djb2` hash, so the same builder always yields the same numbers;
> the only `Math.random()` left in the file is the post-mortem comment explaining its removal. Real
> per-repo signals come from `src/lib/github/repo-signals.ts` via
> `src/routes/api/builders/$builderId/hygiene.ts`, and `src/shared/components/HygieneCard.tsx` labels
> the fallback in the UI as "Estimated from profile signals — not real repo data", so no synthetic
> number is presented as measured fact. This plan **owns the `builders.metadata.projectHygiene` key**
> (namespaced-key convention; `ai-profile-enrichment` owns `aiEnrichment`, `code-fingerprinting` owns
> `codeStyleFingerprint`).

## Problem

The hygiene card promises maintenance signal (issue velocity, docs, CI) but v1 invents its
inputs: fake repo names, random issue counts, random close times. Two page loads of the
same builder can disagree with each other. Recruiters reading "Issue close rate 84%" are
reading noise presented as measurement.

## Goal

Replace fabricated inputs with **real GitHub repo signals** for GitHub-source builders,
fetched lazily via the REST API, persisted in `builders.metadata.projectHygiene` with a
versioned envelope, and rendered by the existing card with an honest provenance caption.
The scoring math (`computeHygiene`) is already correct and stays untouched — v2 only fixes
what goes into it.

- Signals per repo (top 5 by stars, non-fork): open/closed issue counts, average issue
  resolution days, README/CONTRIBUTING/LICENSE presence, CI config presence
  (`.github/workflows/`).
- Non-GitHub builders keep the v1 estimate, clearly labeled.
- The v1 fake-repo generator becomes deterministic (seeded) so the fallback stops flickering.

## Why no AI

Per `_meta/ai-policy.md`, AI is for judgment over unstructured content. Every hygiene input
is a structured fact the GitHub API returns directly (counts, timestamps, file existence).
An LLM would add cost, latency, and hallucination risk to arithmetic. **This plan registers
no AI task and touches nothing under `src/shared/lib/ai/`.**

## Non-goals

- No linting, cloning, or execution of repository contents.
- No private repository scanning (public metadata only).
- No GitLab/Codeberg signals in v2 (their APIs are similar; future increment).
- No search filter "only builders with CI" (needs hygiene density across rows first; revisit
  once real data exists).
- No plan-tier gate: hygiene is not listed in `PLAN_PRICING`; it stays available to all
  tiers, protected by rate limits and the freshness window (cost is GitHub quota, not money).

## User stories

1. As a **recruiter** on a GitHub builder's profile, the hygiene card shows metrics computed
   from their actual top repos, captioned "From 5 public repos · updated 3 days ago".
2. As a **recruiter** on a Hacker News builder's profile, I see the estimated card with an
   explicit "estimated — no repo data for this source" caption; no fake precision.
3. As a **builder** viewing my own claimed profile, the numbers match what I can verify on
   my GitHub repos.

## Data shapes

`RepoSignals` and `ProjectHygiene` in `src/shared/lib/hygiene.ts` already model exactly what
the GitHub API provides — they are reused as-is. New stored envelope:

```ts
export const projectHygieneEnvelopeSchema = z.object({
  hygiene: projectHygieneSchema, // computeHygiene output (existing shape)
  signals: z.array(repoSignalsSchema).max(5), // per-repo rows for the detail view
  computedAt: z.string().datetime(),
  version: z.literal(1),
});
```

Written to `builders.metadata.projectHygiene` via `jsonb_set` (never whole-column overwrite).

## Fetch pipeline (`src/lib/github/repo-signals.ts`)

Per builder (requires `GITHUB_TOKEN`; without it the endpoint 503s and the UI keeps the
estimate):

1. `GET /users/{username}/repos?sort=pushed&per_page=30` → non-fork, `size > 0` → top **5**
   by stars.
2. Per repo (3 requests each, ≤ 16 total per builder):
   - `GET /repos/{o}/{r}/issues?state=all&per_page=100` → filter out rows with a
     `pull_request` key → open/closed counts (bounded window: the 100 most recent — good
     enough for a rate, avoids issue-count pagination storms) and
     `averageCloseDays` = mean of `closed_at - created_at` over closed ones.
   - `GET /repos/{o}/{r}/contents/` (root listing) → `hasReadme` / `hasContributing` /
     `hasLicense` by case-insensitive filename match (also use the repo object's `license`
     field as a cheaper primary source for `hasLicense`).
   - `GET /repos/{o}/{r}/contents/.github/workflows` → 200 with entries = `hasWorkflows`;
     404 = false. (GitLab CI detection is out of scope with the GitHub API; fine — v2 is
     GitHub-only.)
3. `computeHygiene(signals)` (existing, untouched) → envelope → persist.

## API flow

```
GET /api/builders/$builderId/hygiene
  1. auth session; row must belong to the session user
  2. builder.source !== 'github' → 200 { estimated: true } (client keeps v1 card)
  3. metadata.projectHygiene fresh (computedAt < 15 days, version 1, schema-valid)
     → { hygiene, signals, cached: true }
  4. GITHUB_TOKEN unset → 503 { error: 'hygiene_unavailable' } (client keeps v1 card)
  5. rateLimit('hygiene', userId, 10, 3600) → 429 (client keeps v1 card or stale envelope)
  6. fetch signals; zero usable repos → 200 { estimated: true } (not persisted)
  7. computeHygiene → envelope → jsonb_set persist → { hygiene, signals, cached: false }
```

15-day freshness mirrors the fetch cost profile; no `force` refresh in v2 (stale-by-15-days
is acceptable for maintenance signals; claim flow does not need a hook here).

## UI integration

`src/shared/components/HygieneCard.tsx` (modify, don't replace):

- On mount for GitHub builders, fetch `/api/builders/$builderId/hygiene`; while loading,
  render the current layout with a subtle skeleton on the numbers.
- Real envelope → same gauges/metrics + caption "From {n} public repos · {relative date}",
  plus an optional per-repo mini-table (name, close rate, docs, CI) below the checklist.
- `estimated: true` / any error → current heuristic rendering with the caption sharpened to
  "Estimated from profile signals — not real repo data".
- The existing `data-testid`s stay.

## Success metrics

- Two consecutive renders of the same builder show identical numbers (v1's random flicker
  gone — deterministic fallback + persisted envelope).
- Cached card < 100 ms; cold fetch < 8 s (≤ 16 GitHub requests).
- `hygiene.test.ts` keeps passing untouched (scoring math frozen).
- GitHub quota impact ≤ 16 requests per builder per 15 days.

## Resolved edge cases

- **Repo with issues disabled / zero issues**: `computeHygiene` already treats
  `totalAll === 0` as 100% close rate; per-repo table shows "no issues" instead of 100%.
- **All repos are forks**: step 6 estimated path; nothing persisted; card stays honest.
- **GitHub 403 rate-limit mid-fetch**: abort, 503; nothing partial persisted; stale envelope
  (if any) keeps rendering.
- **`metadata.repos` populated by a future source**: `estimateRepoSignalsFromBuilder`
  already prefers real `metadata.repos` — that path keeps working and the endpoint's real
  fetch simply supersedes it.
- **Key collisions in metadata**: `jsonb_set` on `projectHygiene` only; other plans' keys
  untouched.
- **Non-GitHub builder**: explicit `estimated` contract at step 2 — the UI never implies
  real measurement.
