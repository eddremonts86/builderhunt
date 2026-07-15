# Tasks: Stack Overflow Integration

## Phase 0 — Read first

- [ ] `src/lib/sources/hn.ts` — pattern for "people only" source
- [ ] The SO API filter syntax — confusing, need to test

## Phase 1 — Data model

- [ ] No schema changes; `source: 'stackoverflow'`

## Phase 2 — API key setup

- [ ] Register a Stack Overflow app at https://stackapps.com/apps/register
- [ ] Get an API key
- [ ] Add `STACKOVERFLOW_API_KEY` to `src/shared/lib/env.ts`

## Phase 3 — New source: `src/lib/sources/stackoverflow.ts`

- [ ] Add `stackoverflow` to `Source` type
- [ ] `searchStackOverflowUsers(keywords, apiKey)`:
  - `GET /users?site=stackoverflow&pagesize=50&order=desc&sort=reputation&filter=default`
  - Returns top 50 users globally
  - Filter by top-tag overlap with keywords (need a second call)
- [ ] `getTopTags(userIds, apiKey)`:
  - `GET /users/{ids}/top-tags?site=stackoverflow` (batch up to 100 ids)
  - Returns `top_tags: { tag_name, question_score }[]` per user
- [ ] `searchStackOverflow(keywords, apiKey)`:
  - Fetch top 50 users
  - Fetch their top tags in one batch call
  - Filter users where any top tag matches query (or partial)
  - Sort by reputation DESC
  - Map to `RawBuilder`
- [ ] Rate limit: respect 300 req/día without key, 10k with key. Track quota in logs.

## Phase 4 — Wire into pipeline

- [ ] Update `src/lib/search.ts` to include `searchStackOverflow`
- [ ] Update `ALL_SOURCES` and `SOURCE_META` in `SearchPage.tsx`:
  - Add `'stackoverflow'` to `Source` type
  - Add `SOURCE_META.stackoverflow = { label: 'Stack Overflow', color: 'badge-stackoverflow', Icon: StackOverflowIcon }`
  - Add SO to default active sources (7 → 8)
- [ ] Consider opt-in (off by default) due to quota constraints

## Phase 5 — Brand icon + UI

- [ ] Add `StackOverflowIcon` to `BrandIcons.tsx`
- [ ] Color: SO orange `#F48024`
- [ ] Add `.badge-stackoverflow` to `globals.css`

## Phase 6 — Scoring

- [ ] Reputation (log scale, ×10)
- [ ] Top tag overlap with query (×5 per matching tag)
- [ ] Gold badges (×3 per badge)
- [ ] Bio match (×5)

## Phase 7 — Verification

### Manual
- [ ] Search "kubernetes" → see SO users with kubernetes tag
- [ ] Search "rust" → see SO users with rust tag
- [ ] SO card shows orange badge + reputation
- [ ] Quota tracking: see how many calls per search

### Automated (Playwright)
- [ ] SO toggle behavior
- [ ] SO cards have `.badge-stackoverflow` class

### Performance
- [ ] SO endpoint < 600ms (2 calls: users + top-tags)
- [ ] Cache 1h, keyed by `(query, day)` (reputation changes slowly)
- [ ] If 429 (quota exhausted), fall back to cached or empty

## Phase 8 — Rollout

- [ ] **Decide: default on or off?** SO is a strong signal but quota is real. **Recommended**: off by default; opt-in via toggle, with a one-time banner explaining the value.
- [ ] Monitor: quota usage, CTR, dismiss rate
- [ ] If dismiss rate is high: tune scoring, consider reputation threshold

## Edge cases

- **No API key**: rate-limited to 300/day. Disable gracefully if quota exhausted.
- **User with no top tags**: skip
- **No tag overlap with query**: skip (means no expertise match)
- **Deleted SO user**: skip (user.is_deleted check)

## Dependencies

- New env var: `STACKOVERFLOW_API_KEY` (optional, but recommended)
- No schema changes
- No new packages

## Estimated effort

| Phase | Effort |
|-------|--------|
| 2 — API key setup | XS (30min) |
| 3 — New source | M (4-6h) |
| 4-5 — Wire + UI | S (2-3h) |
| 6 — Scoring | S (1-2h) |
| 7 — Verification | S (2-3h) |
| **Total** | **~1.5-2 days** |
