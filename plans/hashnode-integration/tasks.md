# Tasks: Hashnode Integration

> **Note: likely skip**. DEV.to already covers the same audience. Only do if user demand justifies it.

## Phase 0 — Research

- [ ] Test GraphQL endpoint at `https://api.hashnode.com/`
- [ ] Check if API key is required for user search

## Phase 1 — Data model

- [ ] No schema changes; `source: 'hashnode'`

## Phase 2 — GraphQL source

- [ ] New file `src/lib/sources/hashnode.ts`
- [ ] `searchHashnodeUsers(keywords, apiKey)`:
  - GraphQL query: `query { searchUsers(query: "X") { ... } }` (if exists)
  - Or iterate: `query { user(username: "X") }` for each candidate
  - Map to `RawBuilder` with `kind: 'person'`
  - `followersCount: user.numFollowers`
- [ ] `searchHashnode(keywords, apiKey)`: single function

## Phase 3 — Wire

- [ ] Add `HASHNODE_API_KEY` to env
- [ ] Add to `search.ts`, `Source` type (off by default)
- [ ] Add `HashnodeIcon` to `BrandIcons.tsx` (blue)
- [ ] Add `.badge-hashnode` to globals.css

## Phase 4 — Verification

- [ ] Manual: search a known Hashnode user
- [ ] Performance: < 600ms

## Estimated effort

**M (2-3 días)**. GraphQL adds complexity. Marginal value over DEV.to is small.

## Strong recommendation: skip for v1

If we have 2-3 days of engineering time, better candidates:
1. **Lobsters** (1.5 days, unique high-signal community)
2. **Stack Overflow** (1.5-2 days, expertise signal)
3. **Hugging Face** (2-3 days, AI/ML niche)
