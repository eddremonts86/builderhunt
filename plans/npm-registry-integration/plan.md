# Plan: npm Registry Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: `src/lib/sources/npm.ts` shipped (npms.io search + registry metadata +
> maintainer aggregation). Remaining: migrate search off the third-party npms.io service.

## Executed phases (record)

1. **Source file** — `src/lib/sources/npm.ts`: npms.io search, per-package registry
   metadata (parallel, cap 20), maintainer aggregation, email privacy.
2. **Pipeline** — import + gate in `src/lib/search.ts`; `npm` in `SourceName`.
3. **UI** — opt-in pill (the original "off by default" recommendation was adopted),
   `SOURCE_META.npm`, `NpmIcon`, `.badge-npm`.
4. **Scoring** — `npm` branch in `src/lib/score.ts` (multi-package maintainer bonus).

## Remaining phase

### Phase A — First-party search endpoint

Replace `api.npms.io/v2/search` with `GET https://registry.npmjs.org/-/v1/search?text={q}&size=20`
(verified alive; returns `objects[].package` with maintainers inline plus
`objects[].score.final` in the same 0-1 range). Benefits:

- Removes the third-party single point of failure (npms.io has had outages/deprecation
  scares; if it dies the source silently empties).
- The response embeds `maintainers` and `keywords`, so the 20 per-package
  `registry.npmjs.org/{name}` fetches can be dropped or kept only for `time.modified`
  (recency). Prefer keeping one batch of fetches only for packages that make the final
  page slice.

No UI, scoring, or env changes needed — the score scale and shapes stay the same.

## Risks

| Risk                                                              | Likelihood | Impact | Mitigation                                           |
| ----------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------- |
| npms.io disappears before migration                               | Medium     | Medium | This phase; connector already degrades to `[]`       |
| First-party score distribution differs slightly                   | Medium     | Low    | Same 0-1 `score.final` field; spot-check top queries |
| Losing `time.modified` recency if per-package fetches are dropped | Medium     | Low    | Keep per-package fetch for the final slice only      |

## Rollback plan

No migrations, no env vars. The change is contained in `npm.ts`; reverting the fetch URL
restores today's behavior.
