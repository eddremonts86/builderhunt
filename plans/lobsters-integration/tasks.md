# Tasks: Lobsters Integration

## Phase 0 — Read first

- [ ] `src/lib/sources/hn.ts` — closest analog (Hacker News source)
- [ ] Confirm `cheerio` or `linkedom` is OK to add (1 dependency, ~30KB)

## Phase 1 — Data model

- [ ] No schema changes; reuse `source: 'lobsters'`

## Phase 2 — New source: `src/lib/sources/lobsters.ts`

- [ ] Add `lobsters` to `Source` type
- [ ] Add `kind: 'person'` (Lobsters is people-only for now)
- [ ] `searchLobstersUsers(keywords)`:
  - Fetch `/hottest.json` and `/newest.json` in parallel
  - Extract unique `submitter_user.username` from stories
  - For each user (cap at 30), fetch `/u/:username`
  - Parse HTML to extract: `username`, `karma` (from page), bio (text near avatar), tags
  - Match against query keywords (bio + tags)
  - Map to `RawBuilder` with:
    - `id: lobsters-${username}`
    - `source: 'lobsters'`
    - `username`
    - `displayName: undefined` (Lobsters doesn't have separate display names)
    - `avatarUrl: undefined` (would need scraping; skip for v1)
    - `bio: parsed bio or undefined`
    - `profileUrl: https://lobste.rs/u/${username}`
    - `followersCount: parsed karma`
    - `topics: parsed tags`
- [ ] `searchLobsters(keywords)`:
  - Run `searchLobstersUsers`
  - Sort by karma DESC
  - Return top 20

## Phase 3 — HTML parsing

- [ ] Use `cheerio` (lightweight, no DOM, server-friendly): `pnpm add cheerio`
- [ ] OR: use `linkedom` (smaller, ~20KB, more standards-compliant)
- [ ] Helper `parseLobstersProfile(html: string)`:
  - Find bio: `<div class="profile">` first `<p>` tag
  - Find karma: text after "Karma:" or in `<a href="/u/USERNAME">karma</a>`
  - Find tags: `<a href="/t/TAG">TAG</a>` elements
- [ ] Cache: in-memory LRU 10min, keyed by username (Lobsters HTML is heavy)

## Phase 4 — Wire into pipeline

- [ ] Update `src/lib/search.ts` to include `searchLobsters`
- [ ] Update `ALL_SOURCES` and `SOURCE_META` in `SearchPage.tsx`:
  - Add `'lobsters'` to `Source` type
  - Add `SOURCE_META.lobsters = { label: 'Lobsters', color: 'badge-lobsters', Icon: LobstersIcon }`
  - Add Lobsters to default active sources (5 → 6)

## Phase 5 — Brand icon + UI

- [ ] Add `LobstersIcon` to `BrandIcons.tsx` (inline SVG)
- [ ] Color: Lobsters red `#AC130D`
- [ ] Add `.badge-lobsters` to `globals.css`:
  ```css
  .badge-lobsters { background: rgba(172, 19, 13, 0.12); color: #AC130D; border-color: rgba(172, 19, 13, 0.2); }
  ```

## Phase 6 — Scoring

- [ ] Lobsters users have no followers (only karma). Add scoring:
  - Bio keyword match (×10)
  - Tag overlap (×5)
  - Karma (log scale, ×2)
  - Recency (last story submitted within 30 days: ×3; older: ×1)

## Phase 7 — Verification

### Manual
- [ ] Search "compilers" → see Lobsters users with karma > 100
- [ ] Search "rust" → see users with rust in their bio or tags
- [ ] Lobsters card shows the red badge correctly

### Automated (Playwright)
- [ ] Toggle Lobsters off → fewer results
- [ ] Toggle Lobsters on → Lobsters users appear
- [ ] Lobsters cards have `.badge-lobsters` class

### Performance
- [ ] Lobsters endpoint < 800ms (HTML scraping is slower than JSON)
- [ ] Cache username → profile aggressively (10min TTL)

## Phase 8 — Rollout

- [ ] Soft launch with monitoring
- [ ] Watch for HTML layout changes (Lobsters could redesign)
- [ ] If scraping breaks, fall back to a static list of "notable Lobsters users" (hardcoded, low quality but always works)

## Edge cases

- **No JSON for users**: scrape HTML, fail gracefully if layout changes
- **Rate limit (undocumented)**: cache aggressively, max 1 request per 200ms
- **Empty `hottest.json`**: just use `newest.json`
- **User with no bio**: skip (don't show)
- **Username with special chars**: URL-encode properly

## Dependencies

- New package: `cheerio` or `linkedom` (~30KB)
- No schema changes
- No new env vars

## Estimated effort

| Phase | Effort |
|-------|--------|
| 2 — New source | M (4-6h) |
| 3 — HTML parsing | S (2-3h) |
| 4-5 — Wire + UI | S (2-3h) |
| 6 — Scoring | S (1-2h) |
| 7 — Verification | S (2-3h) |
| **Total** | **~1.5 days** |
