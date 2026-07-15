# Plan: Proactive Discovery

## Goal recap

Move BuilderHunt from "search when you need to" to "I open BuilderHunt daily and discover someone new". The lever: a **For you** section in the dashboard that surfaces builders adjacent to the user's interests, before the user searches for them.

## Why this is the right first feature

Three reasons:

1. **Uses data we already have.** No new integrations, no new schema. We already index topics, sources, scores. The signal is in the warehouse.
2. **Changes user behavior.** From "utility on demand" to "daily check-in". Daily active users is the metric that determines if this becomes a product or a tool.
3. **Doesn't compete with anyone.** Multi-source proactive discovery is unique to BuilderHunt. GitHub can't do it (they only know GitHub). LinkedIn can't do it (they don't index public activity). Recruiters can't do it (they don't have recency scoring at this granularity).

## Phases

### Phase 0: Research (already done in this plan)

Read the existing schema, current dashboard, and the `src/routes/api/dashboard/stats.ts` query pattern. Confirmed:
- `builders` table has `topics` (jsonb), `lastSeen`, `source`, `userId`, `score`
- `savedQueries` table has `keywords` (jsonb), `sources` (jsonb), `userId`, `name`
- Drizzle ORM is the query layer

**No new schema or migration needed.**

### Phase 1: Backend endpoint

**Single endpoint:** `GET /api/recommendations`

**Query:** CTE with overlap scoring. Returns top N (default 8) builders with `overlap_count > 0`, filtered to `lastSeen > 90 days`, excluding already-saved.

**Empty-state contract:** the endpoint returns 200 with `recommendations: []` and a `meta.reason` field (`'no_saved_searches'` | `'no_matches'`). The frontend uses the reason to pick which empty state to show.

**Cache:** 5-min in-memory LRU keyed by `user_id`. Skip Redis until we see traffic.

**Effort:** M (4-6h)

### Phase 2: Frontend section

**Component:** `RecommendationsSection` in `src/modules/dashboard/components/`.

**States:** loading skeleton, empty (two variants based on reason), populated grid.

**Reusable card:** extract `<BuilderCard>` to share with `Recent builders` section. Saves duplication and keeps the visual language consistent.

**Effort:** M (4-6h)

### Phase 3: Wire into dashboard

Parallel fetch in the existing `useEffect` so dashboard doesn't block on recommendations. Section renders above the stats grid.

**Effort:** S (1-2h)

### Phase 4: Polish

Animations (already in design system: `animate-fade-in-up`), hover state (`card-hover`), loading pulse, empty state with starter search chips. Analytics data attributes for future tracking.

**Effort:** S (2-3h)

### Phase 5: Verification

- Manual: fresh user, active user, edge cases (no signal, dismissed)
- Automated: Playwright tests for the three main states
- Performance: index `builders.topics` with GIN if not already, benchmark < 200ms for 50 saved searches / 1000 candidates

**Effort:** S (2-3h)

### Phase 6: Rollout

Deploy behind `ENABLE_RECOMMENDATIONS=true` (default true). Monitor for one week:
- **Dismiss rate** (guardrail — target < 40%)
- **Save rate from For-you** (success — target > 15%)
- **Latency p95** (performance — target < 300ms)

If dismiss rate > 40%, tune: lower keyword overlap threshold from default, or add recency boost (multiplier on `lastSeen`).

## Dependency graph

```
Phase 0 (research) ──┐
                     ├──> Phase 1 (backend) ──> Phase 3 (wire) ──┐
                     │                                          ├──> Phase 5 (verify) ──> Phase 6 (rollout)
                     └──> Phase 2 (frontend) ──────────────────┘
```

Phase 1 and 2 can be done in parallel by two agents (different files, no shared code).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Cold start:** new users have no saved searches, recommendations are empty | High | Medium | Two-variant empty state: starter search chips for fresh users, "add more keywords" for users with 0 matches |
| **Noisy recommendations:** algorithm returns irrelevant builders | Medium | High | Reason chips explain every match. Dismiss is client-side. If dismiss > 40%, tune scoring weights. |
| **Performance:** query slow with 10k+ builders | Low | Medium | GIN index on `builders.topics`. 5-min cache. Fallback to top-N by score if query > 500ms. |
| **Multi-source duplicates:** same person shown 2x if indexed in 2 sources | Medium | Low | Dedup by `profileUrl` or `username` in the query. Single card with source badges. |
| **Builders without topics:** no signal, can't be recommended | Medium | Low | Skip them. They'll appear via search. Don't try to infer topics from bio (out of scope). |

## Rollback plan

- Feature flag: `ENABLE_RECOMMENDATIONS=false` hides the section. No DB changes, so no migration rollback needed.
- Endpoint stays deployed (returns 200 with empty array) — no broken state if flag is flipped.

## What this is NOT

- **Not an ML recommender.** No embeddings, no collaborative filtering, no neural networks. Just SQL overlap + ranking.
- **Not a feed.** No infinite scroll, no "load more", no real-time updates. Curated 8-12 cards, refreshed daily.
- **Not a network-effect feature.** Doesn't need other users to work. Works for user #1.
- **Not a social feature.** No follows, no shares, no likes. Pure discovery.

## What this enables (downstream)

Once "For you" works:
1. **Email digest of For-you** (1/week) — same data, different channel
2. **"Similar to this builder"** on profile pages — reuses the overlap algorithm
3. **Starter searches** for cold-start users — pre-curated lists by topic
4. **Team digest** — For-you shared in team workspaces
