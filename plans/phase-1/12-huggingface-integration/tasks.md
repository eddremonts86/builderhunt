# Tasks: Hugging Face Integration

> **Status**: `partially-implemented` (only the explicitly-optional item remains)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped. `.env.example` docs delivered 2026-07-25.
> Remaining: an optional author-profile enrichment ("build only on demonstrated need"-style
> nice-to-have, not required for the plan to be considered done).

## Delivered

- [x] **Create HF connector (models + aggregated authors)** — Done:
      `src/lib/sources/huggingface.ts` (`searchHuggingFace(keywords, {page, perPage})`;
      `/api/models?search=` + author aggregation; private models filtered; errors return `[]`).
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `huggingface` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **Add `HUGGINGFACE_TOKEN` env var** — Done: `src/shared/lib/env.ts` (optional bearer).
- [x] **UI source pill + metadata** — Done: `ALL_SOURCES` + `SOURCE_META.huggingface` in
      `SearchPage.tsx` (opt-in); `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `HuggingFaceIcon` in `BrandIcons.tsx`;
      `.badge-huggingface` in `src/shared/styles/globals.css`.
- [x] **Scoring** — Done: `huggingface` branch in `src/lib/score.ts` (log total-downloads
      bonus; downloads/likes as popularity proxies).

## Remaining

- [x] **Document `HUGGINGFACE_TOKEN` in `.env.example`**
  - Files: `.env.example`
  - Do: add `HUGGINGFACE_TOKEN=` under "External Source API Tokens" (comment: optional,
    raises rate limits; from huggingface.co Settings > Access Tokens, read scope).
  - Verify: `grep HUGGINGFACE_TOKEN .env.example` prints the documented line.
  - **Done.**

- [ ] **(Optional) Enrich top authors with avatar + real followers**
  - Files: `src/lib/sources/huggingface.ts`
  - Do: after author aggregation, for the top 5 authors by total downloads call
    `GET https://huggingface.co/api/users/{username}/overview` in parallel (try/catch per
    call); when it succeeds, set `avatarUrl` and replace the likes-proxy `followersCount`
    with the real `numFollowers`, keeping the aggregate values in `metadata`.
  - Verify: search "llama" with only the HF pill active; the top author cards show avatars;
    when the overview endpoint is blocked (e.g. offline), results equal today's output.
