# Tasks: Lobsters Integration

> **Status**: `implemented` (verified 2026-07-28 against `src/`; see `spec.md`)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: JSON-only connector shipped and default-active. One optional
> enrichment task remains (bio/karma/avatar were promised, never built).

## Delivered

- [x] **Create Lobsters connector (JSON-only)** — Done: `src/lib/sources/lobsters.ts`
      (`searchLobsters(keywords, {page, perPage})`; hottest+newest aggregation, per-user query
      matching, max-score/recency sort; errors return `[]`).
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `lobsters` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **UI source pill (default-active)** — Done: `ALL_SOURCES`,
      `DEFAULT_ACTIVE_SOURCES`, and `SOURCE_META.lobsters` in `SearchPage.tsx`;
      `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `LobstersIcon` in `BrandIcons.tsx`; `.badge-lobsters`
      in `src/shared/styles/globals.css`.
- [x] **Scoring without followers** — Done: `lobsters` branch in `src/lib/score.ts`
      (max story score as `followersCount`, story-count + total-score bonuses).
- [x] **No scraping dependency** — Done by design: no `cheerio`/`linkedom` was added; the
      original scraping plan was replaced with JSON aggregation.

## Future candidate (not scheduled)

Profile-page scraping for bio/karma/avatar requires a separate go/no-go decision and spec
revision. The current JSON-only connector is the supported scope and does not gain an
executable scraping checkbox here.
