# Feature: Lobsters Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector exists at `src/lib/sources/lobsters.ts` and is fully wired;
> `lobsters` is one of the five **default-active** sources in `SearchPage.tsx`. The
> HTML-scraping profile enrichment (bio/karma/avatar) this spec originally recommended was
> never built — the connector works JSON-only.

## Problem

HN is broad (politics, jobs, crypto); Lobsters is the small, heavily-moderated,
high-signal complement focused on programming, security, systems, and languages. For
queries like "distributed systems" or "compilers", Lobsters submitters are top-quality
matches.

## Goal

Index active Lobsters users as `RawBuilder` person records.

## Delivered

Shipped in `src/lib/sources/lobsters.ts` (file header documents the strategy and v1
limitations):

- JSON-only strategy: fetch `https://lobste.rs/hottest.json` + `/newest.json` in parallel,
  dedupe stories by `short_id`, aggregate by `submitter_user`, filter users by query match
  against story titles/descriptions/tags, sort by max story score then recency.
- Mapping: `id: lobsters-{username}`, `kind: 'person'`, `followersCount` = max story score
  (documented quality proxy — Lobsters exposes no followers/karma via JSON), topics from
  matched-story tags, `metadata` includes `storyCount`, `matchedStoryCount`, `totalScore`,
  `maxScore`, `lastSeen`, `sampleTitles`, `representativeUrl`.
- Registered in `src/lib/search.ts` and `SourceName`; **default-active**
  (`DEFAULT_ACTIVE_SOURCES` in `SearchPage.tsx`).
- UI: pill + `SOURCE_META.lobsters`, `LobstersIcon` in `BrandIcons.tsx`, `.badge-lobsters`
  in `src/shared/styles/globals.css`.
- Scoring: `lobsters` branch in `src/lib/score.ts` (story-count activity + total-score
  bonus).
- Fetch errors caught to `[]` (mandatory: `search.ts` uses `Promise.all`).
- No new dependencies, no env vars — the original `cheerio`/`linkedom` plan was avoided.

## Remaining gaps (real, cited from code)

1. **No bio, no avatar, no karma.** `lobsters.ts` sets `bio: undefined`,
   `avatarUrl: undefined`, `displayName: undefined` — the promised `/u/:username` HTML
   scrape was never built. Lobsters person cards are visibly thinner than every other
   source's and lose the 4+2+3 quality points in `score.ts`.
2. **Coverage limited to recent submitters** (hottest + newest, roughly the last few days).
   This is inherent to the JSON-only strategy and is accepted — documented here as a
   constraint, not tracked as a task.

## Non-goals (unchanged)

Story/comment indexing; invite-graph signal; tag browsing.

## Success metrics

- Queries matching recent Lobsters activity ("rust", "security", "unix") return person
  cards; the source contributes zero noise on non-matching queries.
