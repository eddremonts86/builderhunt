# Feature: IndieHackers Integration

> **Status**: `closed — skipped`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Closed 2026-07-25 — product owner chose option (a), skip permanently
> (see "Blocking decision" below). No `src/lib/sources/indiehackers.ts` exists and none
> will be written. Founder-signal coverage moves to `producthunt-integration` and,
> optionally, a user-tagging mini-plan.

## Problem

IndieHackers is the community of bootstrapped technical founders — a builder class
(entrepreneur-engineers sharing revenue and metrics) that no current source captures
directly.

## Goal (if unblocked)

Index IndieHackers members as `RawBuilder` person records searchable by keyword.

## API viability (honest assessment)

- **Official API: none.** There has never been one, and none is announced.
- **The site is a client-rendered SPA** backed by a private Firebase backend; plain
  server-side `fetch` of profile or search URLs returns an app shell without data.
  Extracting people requires a headless browser (and historically a logged-in session),
  which:
  - violates the spirit (and likely the letter) of the site's ToS,
  - cannot run inside the live federated search (`src/lib/search.ts` fires connectors as
    parallel cheap fetches per request), and
  - would need the background-ingestion worker pattern + durable storage
    (`plans/_meta/app-reality.md`, constraint #3) — a much larger plan.
- **No viable third-party data source** offers IndieHackers member data legitimately.

Pretending otherwise would produce a permanently-empty source pill. This plan is therefore
`blocked`, not `pending`.

## Blocking decision (owner: product) — DECIDED 2026-07-25: (a), skip permanently

Choose one:

- **(a) Skip permanently — recommended.** Cover "founder signal" through legitimate
  channels instead:
  - the pending [`producthunt-integration`](../17-producthunt-integration/spec.md) (makers
    ARE largely indie founders, official API, token-gated), and/or
  - user-driven tagging: BuilderHunt users already own `builder_notes` and
    `builders.metadata`; a lightweight "founder / indie hacker" tag + search filter is a
    small, honest feature (would be its own mini-plan, touching
    `src/shared/lib/tracked-builders.ts` and the search UI filters).
- **(b) Approve scraping** — accept ToS risk, a logged-in headless-browser ingestion job,
  and permanent fragility. Requires rewriting this plan as a background-worker plan.
- **(c) Re-check yearly** for an official API announcement.

## Non-goals

Scraping under option (a)/(c); revenue-metric ingestion; anything requiring an
IndieHackers login.

## Success metrics

Only definable after the blocking decision. Under option (a), the success metric moves to
the Product Hunt plan (founder-type coverage) and/or the tagging mini-plan (usage of the
"founder" filter).
