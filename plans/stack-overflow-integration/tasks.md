# Tasks: Stack Overflow Integration

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped. `.env.example` docs and quota-exhaustion
> logging both delivered 2026-07-25.

## Delivered

- [x] **Create SO connector (per-tag top answerers)** — Done:
      `src/lib/sources/stackoverflow.ts` (`searchStackOverflow(keywords, {page, perPage})`;
      `tags/{tag}/top-answerers/all_time` per keyword + `TAG_SYNONYMS`; union with multi-tag
      accumulation; errors return `[]`).
- [x] **Batch top-tags enrichment** — Done: `fetchTopTags` (one call, up to 100 ids) fills
      `topics`.
- [x] **Add `STACKOVERFLOW_API_KEY` env var** — Done: `src/shared/lib/env.ts` (optional,
      appended as `key=`).
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `stackoverflow` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **UI source pill (opt-in, as recommended)** — Done: `ALL_SOURCES` +
      `SOURCE_META.stackoverflow` in `SearchPage.tsx`; `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `StackOverflowIcon` in `BrandIcons.tsx`;
      `.badge-stackoverflow` in `src/shared/styles/globals.css`.
- [x] **Scoring** — Done: `stackoverflow` branch in `src/lib/score.ts` (reputation as
      popularity, +5/+5 multi-tag boosts, log post-count bonus).
- [x] **Deleted/unregistered user filter** — Done: `user_type === 'registered'` filter in
      `searchStackOverflow`.

## Remaining

- [x] **Document `STACKOVERFLOW_API_KEY` in `.env.example`**
  - Files: `.env.example`
  - Do: add `STACKOVERFLOW_API_KEY=` under "External Source API Tokens" (comment: register
    an app at stackapps.com/apps/register; raises quota 300/day/IP to 10k/day).
  - Verify: `grep STACKOVERFLOW_API_KEY .env.example` prints the documented line.
  - **Done.**

- [x] **Log quota exhaustion instead of failing silently**
  - Files: `src/lib/sources/stackoverflow.ts`
  - Do: in `fetchTopAnswerersForTag` / `fetchTopTags`, read `quota_remaining` from the
    parsed body; if `< 50`, call `log.warn('stackoverflow_quota_low', { quotaRemaining })`
    (import `log` from `~/shared/lib/log`, same as `search.ts`); on non-OK responses log
    `log.warn('stackoverflow_request_failed', { status })` before returning `[]`.
  - Verify: temporarily force a bad `key=` value and run a search — the warn line appears
    in server logs and search results still render (SO contributes `[]`).
  - **Done.** Live-verified with real network calls in both directions: a deliberately bad
    `STACKOVERFLOW_API_KEY` produced `{"event":"stackoverflow_request_failed","status":400,
    "endpoint":"top-answerers"}` in the logs and `searchStackOverflow` still returned `[]`
    cleanly (no throw); a real search for "react" with no key returned real answerer cards
    (Dan Abramov et al.) with no warning, confirming the happy path is unaffected.
