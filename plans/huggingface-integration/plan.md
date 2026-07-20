# Plan: Hugging Face Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: The original "defer until AI/ML demand" decision is obsolete — the
> connector shipped (`src/lib/sources/huggingface.ts`). Remaining: env docs plus an
> optional author-profile enrichment.

## Executed phases (record)

1. **Source file** — `src/lib/sources/huggingface.ts`: model search + author aggregation
   (people first, then models), pagination by slicing the combined list.
2. **Pipeline** — import + gate in `src/lib/search.ts`; `huggingface` in `SourceName`.
3. **Env** — optional `HUGGINGFACE_TOKEN` in `src/shared/lib/env.ts`.
4. **UI** — opt-in pill, `SOURCE_META.huggingface`, `HuggingFaceIcon`, `.badge-huggingface`.
5. **Scoring** — `huggingface` branch in `src/lib/score.ts` (log downloads bonus).

## Remaining phases

### Phase A — Env documentation

Add `HUGGINGFACE_TOKEN` to `.env.example`.

### Phase B (optional) — Author enrichment

For the top N (<= 5) aggregated authors per search, call
`GET https://huggingface.co/api/users/{username}/overview` to fill avatar and real
`followersCount`. Cap and parallelize; every failure falls back to the current aggregate.
Only do this if HF person cards see real usage — it multiplies request volume.

## Risks

| Risk                                                    | Likelihood | Impact | Mitigation                                             |
| ------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------ |
| HF API rate limiting                                    | Low        | Low    | 5-min search cache in `search.ts`; token raises limits |
| Author aggregation misses users with no matching models | Certain    | Low    | Accepted v1 scope (documented in connector header)     |

## Rollback plan

No migrations. Remove `'huggingface'` from `ALL_SOURCES` to hide; remove the gate in
`search.ts` to disable.
