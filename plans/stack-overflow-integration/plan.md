# Plan: Stack Overflow Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: `src/lib/sources/stackoverflow.ts` shipped with a per-tag
> top-answerers strategy. Remaining: env docs and quota observability.

## Executed phases (record)

1. **Source file** — `src/lib/sources/stackoverflow.ts`: per-keyword
   `tags/{tag}/top-answerers` with `TAG_SYNONYMS`, cross-keyword union, batch `top-tags`
   enrichment, registered-users filter.
2. **Pipeline** — import + gate in `src/lib/search.ts`; `stackoverflow` in `SourceName`.
3. **Env** — optional `STACKOVERFLOW_API_KEY` in `src/shared/lib/env.ts`.
4. **UI** — opt-in pill (quota-driven recommendation adopted),
   `SOURCE_META.stackoverflow`, `StackOverflowIcon`, `.badge-stackoverflow`.
5. **Scoring** — `stackoverflow` branch in `src/lib/score.ts` (multi-tag boost, post-count
   engagement bonus).

## Remaining phases

### Phase A — Env documentation

Add `STACKOVERFLOW_API_KEY` to `.env.example` (register at stackapps.com).

### Phase B — Quota observability

Read `quota_remaining` from responses and emit a `log.warn` when it drops below a
threshold (e.g. 50) or a request comes back throttled. No behavior change — the connector
must keep degrading to `[]`.

## Risks

| Risk                                            | Likelihood | Impact | Mitigation                                                                    |
| ----------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------- |
| Quota exhaustion (300/day unkeyed)              | High       | Medium | Opt-in pill + 5-min search cache today; Phase A/B make it visible and fixable |
| Tag synonym misses (query term isn't an SO tag) | Medium     | Low    | `TAG_SYNONYMS` map exists; extend as misses are noticed                       |
| SE API deprecation                              | Low        | High   | Mature, versioned API (2.3); monitor                                          |

## Rollback plan

No migrations. Remove `'stackoverflow'` from `ALL_SOURCES` to hide; remove the gate in
`search.ts` to disable.
