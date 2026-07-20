# Tasks: npm Registry Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped. One remaining task: move search to the
> first-party registry endpoint.

## Delivered

- [x] **Create npm connector (packages + aggregated maintainers)** — Done:
      `src/lib/sources/npm.ts` (`searchNpm(keywords, {page, perPage})`; npms.io search +
      parallel registry metadata capped at 20; people first, then packages; errors return `[]`).
- [x] **Maintainer aggregation with email privacy** — Done: `aggregateMaintainer` /
      `maintainerToPersonBuilder` in `npm.ts`; emails deliberately excluded from `metadata`.
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `npm` in `SourceName`
      (`src/lib/sources/types.ts`).
- [x] **UI source pill (opt-in, as recommended)** — Done: `ALL_SOURCES` +
      `SOURCE_META.npm` in `SearchPage.tsx` (not in `DEFAULT_ACTIVE_SOURCES`);
      `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `NpmIcon` in `BrandIcons.tsx`; `.badge-npm` in
      `src/shared/styles/globals.css`.
- [x] **Scoring** — Done: `npm` branch in `src/lib/score.ts` (score-proxy popularity +
      multi-package maintainer bonus).
- [x] **No new env vars / packages** — Done: connector is dependency-free and tokenless.

## Remaining

- [ ] **Migrate search from npms.io to the first-party registry endpoint**
  - Files: `src/lib/sources/npm.ts`
  - Do: replace `NPMS_SEARCH` with
    `https://registry.npmjs.org/-/v1/search?text={q}&size=20`; adapt the mapper to
    `objects[].package` (name, description, keywords, maintainers inline) and
    `objects[].score.final` (same 0-1 range, so the x100000 proxy scale is unchanged).
    Keep per-package `registry.npmjs.org/{name}` fetches only for the final page slice to
    preserve `metadata.lastSeen` from `time.modified`. Keep all try/catch-to-`[]` behavior.
  - Verify: `curl 'https://registry.npmjs.org/-/v1/search?text=react&size=2'` shows the
    expected shape; then search "graphql" with only the npm pill active — maintainer and
    package cards appear with scores comparable to today's.
