# Tasks: Proactive Discovery

## Phase 0 — Research (read first)

- [ ] Read `src/shared/lib/db/schema.ts` to understand `builders`, `savedQueries`, `alerts` schemas
- [ ] Read `src/routes/api/dashboard/stats.ts` to see current query patterns and Drizzle usage
- [ ] Read `src/modules/dashboard/components/DashboardPage.tsx` to see current structure
- [ ] Confirm `builders` table has `topics`, `lastSeen`, `source`, `userId`, `score`, `displayName`, `bio`

## Phase 1 — Data model

- [ ] **No schema changes required.** The data we need already exists.

## Phase 2 — Backend: aggregation query

File: `src/routes/api/recommendations/index.ts` (new)

- [ ] **Endpoint:** `GET /api/recommendations`
- [ ] **Auth:** required (uses `auth.api.getSession`)
- [ ] **Limit:** default 8, max 24
- [ ] **Query strategy** (single SQL with CTE, no Python/JS loops):

```sql
WITH user_searches AS (
  SELECT id, name, keywords, sources
  FROM saved_queries
  WHERE user_id = $1
),
user_seen AS (
  SELECT builder_id FROM alerts WHERE user_id = $1
  -- AND any other "already saved" indicator
),
candidates AS (
  SELECT
    b.*,
    -- Score: keyword overlap × 10 + topic overlap × 5 + source overlap × 2
    (
      SELECT count(*) FROM user_searches us
      WHERE b.topics && us.keywords
        OR us.sources @> ARRAY[b.source]
    ) AS overlap_count,
    array_agg(DISTINCT us.name) FILTER (WHERE us.id IS NOT NULL) AS matched_searches
  FROM builders b
  WHERE b.user_id = $1
    AND b.last_seen > now() - interval '90 days'
    AND b.id NOT IN (SELECT builder_id FROM user_seen)
  GROUP BY b.id
)
SELECT *
FROM candidates
WHERE overlap_count > 0
ORDER BY overlap_count DESC, score DESC
LIMIT $2;
```

- [ ] **Response shape:** `{ recommendations: Recommendation[], meta: { basedOnSearches: number, totalCandidates: number } }`
- [ ] **Empty state handling:**
  - If `user_searches` is empty → return `{ recommendations: [], meta: { reason: 'no_saved_searches' } }`
  - If `candidates` is empty → return `{ recommendations: [], meta: { reason: 'no_matches' } }`
- [ ] **Error handling:** wrap in try/catch, return 200 with `[]` (frontend handles empty), log error
- [ ] **Cache:** in-memory LRU with 5 min TTL keyed by user_id. Add `@upstash/redis` or similar only if traffic warrants.

## Phase 3 — Frontend: section component

File: `src/modules/dashboard/components/RecommendationsSection.tsx` (new)

- [ ] **Component signature:** `function RecommendationsSection({ initialData }: { initialData?: Recommendation[] })`
- [ ] **Fetch on mount** if `initialData` is null
- [ ] **States:**
  - Loading → skeleton (3 cards)
  - Empty (no_saved_searches) → empty state with starter suggestions
  - Empty (no_matches) → empty state "Try adding more keywords to your searches"
  - Populated → grid of cards
- [ ] **Card component:** extract reusable `<BuilderCard>` to share with `Recent builders` section
- [ ] **Reasons display:** chip-style below the card, max 2 visible + "+N more" if more
- [ ] **Dismiss action:** client-side only (no persistence) for v1
- [ ] **Save action:** POST to `/api/queries/:id/save-builder` (or whatever the existing endpoint is — check the codebase)

## Phase 4 — Wire into dashboard

File: `src/modules/dashboard/components/DashboardPage.tsx`

- [ ] Add `<RecommendationsSection />` **above** the stats grid
- [ ] Parallel fetch in the existing `useEffect`:
  ```ts
  Promise.all([
    fetch('/api/dashboard/stats'),
    fetch('/api/queries'),
    fetch('/api/builders/recent'),
    fetch('/api/recommendations'),  // NEW
  ])
  ```
- [ ] Don't block the dashboard render on recommendations: show dashboard first, recommendations load progressively

## Phase 5 — Polish

- [ ] **Animations:** cards stagger-fade in with `animate-fade-in-up` (CSS class already exists)
- [ ] **Hover state:** card lifts and border brightens (`card-hover` already exists)
- [ ] **Loading state:** pulse animation (already in design system)
- [ ] **Empty state illustration:** inline SVG (or reuse the existing hero illustration cropped)
- [ ] **Analytics:** add `data-event="recommendation_view"` and `data-event="recommendation_save"` to the cards for future tracking

## Phase 6 — Verification

### Manual
- [ ] Sign in as fresh user (0 saved searches) → see empty state with starter suggestions
- [ ] Sign in as user with 1 saved search ("rust async") → see 0-8 recommendations matching rust/async topics
- [ ] Save a builder from a recommendation → it disappears from "For you" on next load
- [ ] Check no console errors, no layout shift

### Automated (Playwright)
- [ ] Test: fresh user sees empty state
- [ ] Test: with seed data, user with saved searches sees ≥3 recommendations
- [ ] Test: clicking "Save" on a recommendation calls the right endpoint

### Performance
- [ ] Endpoint response time: < 200ms for user with 50 saved searches and 1000 candidate builders (index on `builders.user_id`, `builders.last_seen`, `builders.topics` — GIN index on topics)
- [ ] Dashboard still renders in < 1s with recommendations enabled

## Phase 7 — Rollout

- [ ] Deploy behind a `ENABLE_RECOMMENDATIONS=true` env var (default true)
- [ ] Monitor for 1 week: dismiss rate, save rate, latency
- [ ] If dismiss rate > 40%, tune the algorithm (lower keyword overlap threshold, add recency boost)

## Edge cases to handle

- Builder with `topics = []` (no signal) → don't recommend them
- Saved search with `keywords = []` (empty search) → exclude from matching
- User has 0 saved searches but 50 saved builders → alternative source of signal: extract topics from saved builders, use as keywords
- Builder that user previously dismissed → exclude (track in `user_dismissed` table, or in-memory cookie for v1)

## Dependencies

- Existing: `auth.api.getSession`, `db`, `builders`, `savedQueries` tables
- New package: none
- Schema migration: none

## Estimated effort

| Phase | Effort |
|-------|--------|
| 2 — Backend query | M (4-6h) |
| 3 — Frontend section | M (4-6h) |
| 4 — Dashboard wiring | S (1-2h) |
| 5 — Polish | S (2-3h) |
| 6 — Verification | S (2-3h) |
| **Total** | **~2 days** |
