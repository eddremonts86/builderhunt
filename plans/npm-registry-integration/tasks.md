# Tasks: npm Registry Integration

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped. Migrated off npms.io to the first-party
> registry search endpoint 2026-07-25.

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

- [x] **Migrate search from npms.io to the first-party registry endpoint**
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
  - **Done, with one real correction to the task's own assumption.** Curled the real endpoint
    first (`curl 'https://registry.npmjs.org/-/v1/search?text=react&size=2'`) rather than
    trusting the task's shape description, and found `score.final` on this endpoint is an
    **unbounded relevance/ranking score** (~2320 for an exact-name hit like "react"), not
    npms.io's bounded 0-1 quality score the task assumed — `score.final × 100000` would have
    produced absurd `followersCount` values (232M+). Used `score.detail.quality` instead
    (genuinely bounded 0-1, same semantic role npms.io's `score.final` used to serve) as the
    `followersCount` proxy scale. Documented this in the file's own header comment so a future
    reader doesn't reintroduce the bug by "fixing" it back to the task's literal wording.
    - Search results already include maintainers/keywords/license/version inline
      (`objects[].package`), plus a top-level `updated` timestamp on every result — so
      maintainer aggregation across all 20 results needs zero extra fetches now (previously
      required fetching full metadata for every one of the top 20, regardless of pagination).
      Package cards default to the inline search-result fields; only for packages that
      actually land in the requested page slice does the code make the extra
      `registry.npmjs.org/{name}` call, to prefer `time.modified`/`dist-tags.latest` when that
      succeeds, falling back to the inline `updated`/`version` fields if it fails — exactly the
      "only for the final page slice" instruction, implemented as a real pagination-aware
      optimization rather than the old always-fetch-all-20 behavior.
    - **Live-verified with real network calls** (no mocking): searched "graphql" at multiple
      pages — maintainer cards (`npm-user-*`) return with sensible bounded `followersCount`
      values (0–100000) and real `lastSeen` timestamps from real npm publish dates; confirmed
      package cards on a later page carry `version`/`license`/`lastSeen` correctly. Removed
      the throwaway smoke-test scripts afterward.
    - `pnpm tsc --noEmit`/`pnpm eslint` clean; full `pnpm vitest run` (2004/2004) — this
      connector has no dedicated test file, matching the same no-unit-tests-for-connectors
      convention confirmed on the `gitlab-integration` task just before this one.
