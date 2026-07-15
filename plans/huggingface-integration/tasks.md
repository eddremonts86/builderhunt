# Tasks: Hugging Face Integration

> **Note: deferred** until top picks ship and we validate AI/ML demand.

## Phase 0 — Research

- [ ] Test user search at `https://huggingface.co/api/users?search=X`
- [ ] Check rate limits and ToS
- [ ] Test profile endpoint `/api/users/{username}`

## Phase 1 — Data model

- [ ] No schema changes; `source: 'huggingface'`

## Phase 2 — Source

- [ ] New file `src/lib/sources/huggingface.ts`
- [ ] `searchHuggingFaceUsers(keywords, token?)`:
  - `GET /api/users?search={query}` (limited, may need to iterate)
  - For each user, fetch `/api/users/{username}` for full profile
  - Map to `RawBuilder` with `kind: 'person'`
  - `followersCount: user.numFollowers` (HF exposes this!)
  - Topics from model tags
- [ ] `searchHuggingFaceModels(keywords, token?)`:
  - `GET /api/models?search={query}&limit=20`
  - Map to `RawBuilder` with `kind: 'repo'`
  - `followersCount: model.downloads` (proxy for popularity)
- [ ] `searchHuggingFace(keywords, token?)`: combine

## Phase 3 — Wire

- [ ] Add `HUGGINGFACE_TOKEN` to env (optional)
- [ ] Add to `search.ts`, `Source` type, default active sources (off by default)
- [ ] Add `HuggingFaceIcon` to `BrandIcons.tsx` (yellow smiley)
- [ ] Add `.badge-huggingface` to globals.css

## Phase 4 — Scoring

- [ ] Model downloads (log scale, ×5)
- [ ] Followers (log scale, ×3)
- [ ] Bio match (×10)
- [ ] Recency (×5 if model published last week)

## Phase 5 — Verification

- [ ] Manual: search "transformers" → see HF users
- [ ] Manual: search "stable diffusion" → see HF users
- [ ] Performance: < 600ms
- [ ] Rate limit handling

## Estimated effort

**M (2-3 días)**. API is decent but user search is limited.
