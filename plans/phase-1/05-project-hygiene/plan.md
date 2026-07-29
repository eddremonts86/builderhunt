# Project Hygiene — Real GitHub Signals (plan)

> **Status**: `implemented` (all phases below are delivered; kept as the record)
> **Depends on**: nothing (no AI; uses existing `GITHUB_TOKEN` env)
> **Blocks**: nothing
> **Reality check (verified 2026-07-28)**: the three deliverables this plan scoped all exist — the
> fetch module (`src/lib/github/repo-signals.ts`), the endpoint
> (`src/routes/api/builders/$builderId/hygiene.ts`), and the card upgrade
> (`src/shared/components/HygieneCard.tsx`, which renders real signals when GitHub answers and an
> explicitly labelled estimate when it does not). Inputs are no longer fabricated: the estimator is
> hash-seeded and deterministic.

## Delivered (v1 — do not re-plan)

- Pure scoring: `computeHygiene`, `hygieneGrade` — `src/shared/lib/hygiene.ts`, tested in
  `hygiene.test.ts`.
- Fallback signal estimator: `estimateRepoSignalsFromBuilder` (same file) — currently
  non-deterministic (`Math.random`).
- Profile card: `src/shared/components/HygieneCard.tsx`, mounted in `BuilderProfilePage.tsx`.

## Phases (v2)

### Phase 1 — Deterministic fallback (tiny, independently shippable)

Replace `Math.random()` in `estimateRepoSignalsFromBuilder` with values derived from a
stable hash of `username + repo name`, so the estimate stops changing between renders.
Behavior contract otherwise unchanged; tests updated to assert determinism.

### Phase 2 — Real signal fetcher (no UI change yet)

`src/lib/github/repo-signals.ts`: top-5 repo selection, per-repo issues window (100 most
recent, PRs filtered out), docs/CI presence checks, ≤ 16 requests per builder, typed errors
for missing token / rate limit. Pure aggregation helpers unit-tested with fixture payloads.

### Phase 3 — Endpoint + persistence

`GET /api/builders/$builderId/hygiene` implementing the spec's 7-step flow: ownership check,
GitHub-only, 15-day freshness on `metadata.projectHygiene`, rate limit 10/user/h, envelope
persist via `jsonb_set`.

### Phase 4 — Card upgrade

`HygieneCard.tsx` fetches the endpoint for GitHub builders; real data gets the provenance
caption + per-repo mini-table; estimated/error paths keep the heuristic with an explicit
"estimated" caption.

## Risks

| Risk                                               | Likelihood | Impact | Mitigation                                                                                                                       |
| -------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| GitHub quota pressure (≤ 16 req/builder)           | Medium     | Medium | `GITHUB_TOKEN` required (5k/h); 15-day persisted freshness; 10/user/h rate limit; top-5 repos only, single issues page per repo. |
| Issue window (100 recent) misrepresents huge repos | Medium     | Low    | It is a rate over a recent window — caption says "recent issues"; no pagination storms accepted as the trade-off.                |
| Estimated card mistaken for real data              | Medium     | Medium | Explicit `estimated: true` contract + sharpened caption; real data path visually distinct (provenance line).                     |
| Fetch latency blocks profile render                | Low        | Low    | Card fetches independently after mount with skeleton; profile page never waits on it.                                            |

## Rollback plan

- The endpoint is additive; if GitHub quota becomes a problem, return `estimated: true`
  unconditionally (one-line change) — the card degrades to v1 behavior everywhere.
- Persisted envelopes live under one namespaced metadata key; inert if unused, clearable
  with a single `jsonb - 'projectHygiene'` update.
