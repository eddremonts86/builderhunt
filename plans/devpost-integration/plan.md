# Plan: Devpost Integration

> **Status**: `blocked`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Blocked on data access, not on engineering. Devpost has no official
> API and its unofficial JSON search returns an HTTP 202 bot-challenge to server-side
> requests (verified 2026-07-19). No connector work should start until the decision in
> `spec.md` ("Blocking decision") is made.

## Why there are no implementation phases yet

Every existing source connector (`src/lib/sources/*.ts`) is a cheap, tokenless-or-token
HTTP fetch executed live inside `searchBuilders` (`src/lib/search.ts`). Devpost cannot be
that today:

- Server-side `fetch` is bot-challenged (202 + HTML), so a connector would return `[]`
  100% of the time — worse than not shipping it (dead pill in the UI).
- The only working approaches (headless browser or paid scraping API) are incompatible
  with per-search latency and with the connector pattern; they would force the
  background-ingestion worker pattern (`plans/_meta/app-reality.md`, constraint #3) plus
  durable storage — a different and much larger plan.

## Decision matrix (for the product owner)

| Option                             | Cost                                        | Risk                          | Outcome                                                        |
| ---------------------------------- | ------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| (a) Skip permanently               | none                                        | none                          | Close plan; hackathon signal via GitHub + Product Hunt         |
| (b) Approve scraping ingestion job | ~1-2 weeks + possible scraping-service fees | ToS/IP-ban, ongoing fragility | New plan: cron-triggered ingestion worker writing durable rows |
| (c) Re-check quarterly             | ~5 min/quarter                              | none                          | Stay `blocked`; unblock instantly if the JSON endpoint reopens |

Recommendation: **(a)**, with (c) as the zero-cost fallback if there is appetite to keep
the door open.

## If (b) is ever approved — phase outline (do not execute now)

1. Ingestion worker endpoint (`/api/admin/devpost/run-worker`, admin-authed, hit by VPS
   cron) using the approved scraping mechanism.
2. Durable storage decision (per `app-reality.md`: search results are ephemeral; scraped
   people must land in `builders` or a new global table — the per-user vs global tension
   applies).
3. Only then a thin `src/lib/sources/devpost.ts` that queries the durable store (fast,
   safe, fits the connector contract), plus the standard registration/UI/scoring steps.

## Rollback plan

Nothing to roll back — no code exists and none should be written while blocked.
