# Feature: Hugging Face Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector exists at `src/lib/sources/huggingface.ts` and is fully
> wired (pipeline, pill, badge, icon, scoring, `HUGGINGFACE_TOKEN` env var). Remaining:
> `.env.example` documentation and an optional author-profile enrichment.

## Problem

Hugging Face is the canonical AI/ML hub. Queries like "LLM fine-tuning", "transformers",
or "diffusion" find their best builders there, not on general-purpose forges.

## Goal

Index HF model authors (people) and models (repos) as `RawBuilder` records.

## Delivered

Shipped in `src/lib/sources/huggingface.ts` (file header documents the strategy):

- Model search: `GET https://huggingface.co/api/models?search={q}&limit=20&full=true`
  (works unauthenticated; optional `HUGGINGFACE_TOKEN` bearer header).
- Two entity kinds from one call:
  - `kind: 'repo'` — each public model (`id: hf-model-{_id}`), downloads as
    `followersCount`, tags as topics, `metadata.lastSeen` from `createdAt`.
  - `kind: 'person'` — authors aggregated from the result set
    (`id: hf-{username}`), total likes as `followersCount` proxy, aggregated tags,
    model count / total downloads in metadata. The original plan's "user search API"
    approach was dropped deliberately: HF's user-search endpoint requires auth, so
    authors are derived from matched models instead (documented in the connector header).
- Registered in `src/lib/search.ts` and `SourceName` (`src/lib/sources/types.ts`).
- UI: opt-in pill in `ALL_SOURCES` + `SOURCE_META` (`SearchPage.tsx`), `HuggingFaceIcon`
  in `BrandIcons.tsx`, `.badge-huggingface` in `src/shared/styles/globals.css`.
- Scoring: `huggingface` branch in `src/lib/score.ts` (log total-downloads bonus).
- All fetches try/caught to `[]` (mandatory: `search.ts` uses `Promise.all`).

## Remaining gaps (real)

1. **`HUGGINGFACE_TOKEN` is missing from `.env.example`.**
2. **Author cards lack avatar and real follower counts** — the per-user endpoint
   (`GET /api/users/{username}/overview`) was never called. Known v1 limitation stated in
   the connector header; kept as an optional enrichment task (adds N requests per search,
   so it must be batched/capped).

## Non-goals (unchanged)

Datasets and Spaces (models cover the discovery need); HF discussion activity; paid
Inference endpoints.

## Success metrics

- Searching "stable diffusion" or "llama" with only the HF pill active returns author
  person-cards above model repo-cards, sorted by impact (total downloads).
