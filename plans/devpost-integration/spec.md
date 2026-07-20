# Feature: Devpost Integration

> **Status**: `blocked`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: No `src/lib/sources/devpost.ts` exists; `devpost` is not in
> `SourceName` (`src/lib/sources/types.ts`). Devpost has **no official API**, and its
> unofficial JSON search endpoint is behind bot protection — verified 2026-07-19:
> `GET https://devpost.com/software/search?query=ai` with JSON/XHR/browser-like headers
> returns **HTTP 202 with an HTML challenge page**, not data. A decision is required
> before any implementation (see "Blocking decision").

## Problem

Hackathon participants and winners are high-velocity builders who ship working software
under time pressure — a signal no current source captures. Devpost is the canonical
hackathon platform.

## Goal (if unblocked)

Index Devpost participants as `RawBuilder` person records: search projects by keyword,
extract team members, map their profiles (bio, linked GitHub/Twitter, wins).

## API viability (honest assessment)

- **Official API: none.** Devpost has never published one.
- **Unofficial JSON search** (`/software/search?query=...`): historically returned JSON to
  XHR requests, but server-side requests now receive a **202 bot-challenge** (verified
  from this machine with `Accept: application/json`, `X-Requested-With: XMLHttpRequest`,
  and a Chrome User-Agent). Plain server-side `fetch` — the pattern every existing
  connector uses — cannot get data.
- **Profile pages** (`devpost.com/{username}`): HTML only; the same challenge applies.
- Therefore every implementation path is a scraping path:
  1. Headless browser (Playwright) on the VPS — heavyweight, fragile, likely
     ToS-violating, and does not fit the connector pattern (connectors are cheap parallel
     fetches inside a live search request; a browser session cannot run per-search).
  2. Third-party scraping API (paid) — recurring cost, still fragile, still gray-area.
  3. Wait / periodic re-check whether the JSON endpoint reopens.

## Blocking decision (owner: product)

Choose one:

- **(a) Skip permanently** — recommended. Hackathon signal is partially covered by
  GitHub (hackathon repos) and the pending Product Hunt integration (launch signal).
  Close this plan as out of scope.
- **(b) Approve scraping** — accept ToS risk + a paid scraping service or a scheduled
  headless-browser job. Note this CANNOT be a live search connector: it would have to be
  a background ingestion job (per the app's HTTP-cron worker pattern,
  `plans/_meta/app-reality.md` constraint #3) writing into durable storage, which makes
  it a materially different, larger plan than the other source integrations.
- **(c) Re-check later** — leave `blocked`; re-probe the JSON endpoint quarterly (a
  one-line curl, documented in tasks.md).

## Sketch retained for option (b)/(c) — only valid if data access exists

- People come from **project team members**: search projects by keyword, resolve members,
  then their profiles.
- Mapping: `id: devpost-{username}`, `kind: 'person'`, `followersCount: undefined`
  (Devpost exposes no follower count; do NOT fake it with project counts — put
  `projectsCount`, `winsCount`, `lastSeen` (latest submission) in `metadata` and let
  `src/lib/score.ts` use a `devpost` branch: log project count + win bonus).
- Linked GitHub usernames go in `metadata.gitHubUsername`; `src/lib/dedup.ts` merges by
  `username.toLowerCase()` only, so cross-source stitching stays out of scope.
- Failure behavior: like all connectors, every error must degrade to `[]` because
  `src/lib/search.ts` runs sources with `Promise.all`.

## Non-goals

Hackathon registration; full catalog crawling; rebuilding Devpost portfolios in the UI.

## Success metrics

Defined only after the blocking decision selects (b): >=1 devpost person card on hackathon
keyword queries ("ai agent", "hardware hack") from the ingestion job's data.
