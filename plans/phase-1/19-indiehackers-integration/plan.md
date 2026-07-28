# Plan: IndieHackers Integration

> **Status**: `closed — skipped`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Closed 2026-07-25 — product owner chose option (a) from the decision
> matrix below. No code will be written for this source; see `spec.md` for the closure
> note and replacements.

## Why there are no implementation phases

- Live connectors must be cheap parallel HTTP fetches inside `searchBuilders`
  (`src/lib/search.ts`, `Promise.all`); IndieHackers offers no endpoint that pattern can
  consume.
- The only technical path (logged-in headless browser) is ToS-hostile, fragile, and
  forces the background-ingestion worker + durable-storage architecture
  (`plans/_meta/app-reality.md`, constraint #3) — a different, larger plan that should
  only be written if scraping is explicitly approved.

## Decision matrix (for the product owner)

| Option                                                   | Cost                         | Risk                                              | Outcome                            |
| -------------------------------------------------------- | ---------------------------- | ------------------------------------------------- | ---------------------------------- |
| (a) Skip; cover founders via Product Hunt + user tagging | small (tagging mini-plan)    | none                                              | Recommended                        |
| (b) Approve scraping ingestion job                       | 1+ week, ongoing maintenance | ToS violation, account bans, breakage on redesign | Rewrite this plan as a worker plan |
| (c) Re-check yearly for an official API                  | ~5 min/year                  | none                                              | Stay `blocked`                     |

Recommendation: **(a)**. The Product Hunt integration (official API) reaches most of the
same population with real traction signals, and the tagging filter serves users who need
an explicit "founder" facet.

## If (a) is chosen — follow-ups outside this plan

1. Execute [`producthunt-integration`](../17-producthunt-integration/plan.md).
2. Optionally spec a small "builder tags + founder filter" feature (tracked builders
   already own `builders.metadata`; a namespaced `metadata.userTags` key would follow the
   shared-surface convention in `plans/_meta/conventions.md`).
3. Close this directory with final status headers pointing at those replacements.

## Rollback plan

Nothing to roll back — no code exists and none should be written while blocked.
