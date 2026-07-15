# Plan: Stack Overflow Integration

## Goal recap

Add SO as a high-signal expertise source. Different angle: SO reputation is one of the strongest expertise signals in the dev world.

## Why this is the fourth pick

1. **Highest expertise signal.** A user with 10k rep in `kubernetes` knows Kubernetes deeply. Better than GitHub stars for "expertise in X".
2. **Public API** (with key) covers nearly all popular programming topics.
3. **Mature ecosystem.** Most popular tags have hundreds of high-rep users.

## Phases

### Phase 0: Research (done in plan)

Confirmed:
- `https://api.stackexchange.com/2.3/`
- `/users?site=stackoverflow&sort=reputation&order=desc`
- `/users/{ids}/top-tags?site=stackoverflow`
- Quota: 300/day without key, 10k/day with key

### Phase 1: Data model

No changes. `source: 'stackoverflow'`, all `kind: 'person'`.

### Phase 2: API key

Register app at stackapps.com, get key, add `STACKOVERFLOW_API_KEY` to env.

### Phase 3: Source

New file `src/lib/sources/stackoverflow.ts`. Two-step:
1. Fetch top 50 users by reputation
2. Fetch their top tags in batch
3. Filter by tag overlap with query
4. Sort by reputation

### Phase 4-5: Pipeline + UI

Add to `search.ts`, `Source` type, default active sources, brand icon (SO orange `#F48024`).

### Phase 6: Scoring

Reputation (log scale, ×10), tag overlap (×5), gold badges (×3), bio match (×5).

### Phase 7-8: Verification + rollout

**Recommended: OFF by default**, opt-in via toggle, with a one-time banner.

Why: SO is great but quota is real. Better to launch opt-in, measure CTR/dismiss, then decide on default.

## Dependency graph

```
Phase 0 ──> Phase 1 (key) ──> Phase 2 (source) ──> Phase 3 (UI) ──> Phase 4 (scoring) ──> Phase 5 (verify) ──> Phase 6 (rollout)
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Quota exhaustion (300/day without key)** | High | High | Require API key; off by default; cache aggressively |
| **API changes / deprecation** | Low | High | SO API is mature, stable for years; monitor |
| **Tag matching too restrictive** | Medium | Medium | Use partial match (e.g., "rust" matches `rust-lang`); tune in v1.1 |
| **Quality vs GitHub (lower volume)** | Medium | Low | SO is more selective, fewer but higher-quality |

## Rollback plan

- `ENABLE_STACKOVERFLOW=false` env var
- No migrations
- Toggle in UI

## What this is NOT

- **Not Stack Exchange network.** Just SO. v2: add Server Fault, Super User, etc.
- **Not real-time reputation.** Cache 1h.
- **Not full-text search.** Tag-based only.

## What this enables (downstream)

Once SO works:
1. **Stack Exchange network** — Server Fault, Super User, Ask Ubuntu, etc.
2. **Expertise graph** — "Users who know X also know Y" (co-occurrence of top tags)
3. **SO answers stream** — see what a user has been answering recently
4. **Cross-source dedup by display name** — same person on SO + GitHub
