# Plan: Lobsters Integration

> **Status**: `implemented` (see `spec.md`; the optional enrichment below is a closed non-goal)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: `src/lib/sources/lobsters.ts` shipped with a JSON-only strategy (no
> scraping dependency). Remaining work is the optional profile enrichment this plan
> originally recommended.

## Executed phases (record)

1. **Source file** — `src/lib/sources/lobsters.ts`: hottest+newest JSON aggregation by
   submitter, query filtering, quality-proxy scoring inputs. No `cheerio`/`linkedom`
   dependency was added (deliberate simplification vs. the original plan).
2. **Pipeline** — import + gate in `src/lib/search.ts`; `lobsters` in `SourceName`.
3. **UI** — pill (default-active), `SOURCE_META.lobsters`, `LobstersIcon`,
   `.badge-lobsters`.
4. **Scoring** — `lobsters` branch in `src/lib/score.ts`.

## Remaining phase

### Phase A (optional) — Profile enrichment via HTML parse

Fetch `https://lobste.rs/u/{username}` for the users that survive query filtering (cap ~15
per search) and extract bio, karma, and avatar with tolerant regexes — no new dependency
needed for three fields. Every parse failure must fall back to today's undefined values.

Decision gate before doing it: accept the fragility of HTML parsing (layout changes break
silently to today's behavior) in exchange for richer cards and honest karma-based
popularity. If declined, close this plan as `implemented` with the limitation recorded in
the spec.

## Risks

| Risk                                   | Likelihood | Impact | Mitigation                                                             |
| -------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------- |
| HTML layout changes break enrichment   | Medium     | Low    | Regex failures fall back to current JSON-only card                     |
| Extra ~15 requests per uncached search | Certain    | Medium | Cap fetches; rely on the 5-min search cache; fetch only filtered users |
| Undocumented rate limits               | Low        | Low    | Polite User-Agent already set; caching                                 |

## Rollback plan

No migrations, no env vars. Removing the enrichment call restores today's connector; the
source itself can be hidden by removing `'lobsters'` from `ALL_SOURCES` /
`DEFAULT_ACTIVE_SOURCES`.
