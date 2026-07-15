# Tasks: RSS Feeds per Saved Search

## Phase 0 — Research (read first)

- [ ] Read `src/shared/lib/db/schema.ts` to confirm `savedQueries` columns
- [ ] Read `src/routes/api/queries/` to see existing query endpoints
- [ ] Read `src/modules/dashboard/components/DashboardPage.tsx` to see how saved searches are rendered
- [ ] Confirm we have a way to fetch builders matching a saved search's keywords + sources (or build that query)

## Phase 1 — Data model

- [ ] **No schema changes.** Use existing `savedQueries` and `builders` tables.
- [ ] (Future) Add `savedQueries.isPublic` flag if we want to allow users to mark some searches as private. **Skip for v1** (assume all feeds are public by URL).

## Phase 2 — Backend: RSS endpoint

File: `src/routes/api/feeds/$searchId[.]xml.ts` (TanStack Start file-based route)

- [ ] **Route:** `GET /api/feeds/:searchId.xml`
- [ ] **No auth required.** Public endpoint.
- [ ] **Response:** `Content-Type: application/rss+xml; charset=utf-8`
- [ ] **Headers:** `Cache-Control: public, max-age=3600`
- [ ] **Steps:**
  1. Fetch `savedQuery` by `id`. If not found → 404.
  2. Fetch matching builders: `lastSeen > now() - 90 days`, ordered by `lastSeen DESC`, limit 50.
     - Match: `keywords` overlap with builder `topics` OR `sources` contains builder `source`.
  3. Render RSS 2.0 XML.
  4. Return as string.

- [ ] **XML generation:** use a small helper, no need for a library. Avoid `xml` packages — they add bundle weight. 30 lines of template literal.

```ts
const escapeXml = (s: string) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

const renderRssFeed = (search, builders) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(`BuilderHunt — ${search.name}`)}</title>
    ...
  </channel>
</rss>`
```

- [ ] **Rate limiting:** simple in-memory token bucket per IP. 60 req/h, returns 429 if exceeded.

## Phase 3 — Backend: human-friendly HTML fallback

File: same endpoint, detect `Accept: text/html` vs `application/rss+xml`

- [ ] If `Accept` includes `text/html` AND does NOT include `application/rss+xml` (or `*/*`), render a nice HTML page explaining the feed
- [ ] HTML page: hero, "This is a public RSS feed for [search name]", "Subscribe with..." (icons for Feedly, Inoreader, NetNewsWire), recent 5 items as a preview
- [ ] Link to `/explore` (future) and to sign up

## Phase 4 — Frontend: RSS button on saved searches

File: `src/modules/dashboard/components/SavedSearchRow.tsx` (new, extract from current DashboardPage)

- [ ] **Component:** `<SavedSearchRow search={q} />` with `[Run] [RSS]` actions
- [ ] **RSS button:** opens a small popover/modal with:
  - URL (read-only input)
  - Copy button
  - "Open in Feedly" link (`feedly://import/...?url=...` deep link or web)
  - "Open in Inoreader" link
  - Helper text: "Anyone with this link can subscribe"
- [ ] Use the existing `card` + `btn-ghost` + `btn-secondary` styles

## Phase 5 — Shareable "all my searches" URL

- [ ] On the dashboard, add a "Share" button that copies a pre-filled URL with all search IDs as query params
- [ ] When visiting the shared URL, show a "BuilderHunt — see what I'm tracking" page that links to individual feeds

## Phase 6 — Verification

### Manual
- [ ] Copy feed URL, paste in Feedly → see items
- [ ] Visit feed URL in browser with `Accept: text/html` → see nice page
- [ ] Visit feed URL in browser without `Accept` header → see XML
- [ ] Validate XML with https://validator.w3.org/feed/
- [ ] Test 404 (non-existent searchId)
- [ ] Test 429 (rate limit)

### Automated (Playwright)
- [ ] GET /api/feeds/<real-id>.xml → 200, content-type xml, parses as valid XML
- [ ] GET /api/feeds/does-not-exist.xml → 404
- [ ] GET /api/feeds/<real-id>.xml with Accept: text/html → 200, content-type html, contains "Subscribe"

### Performance
- [ ] Feed endpoint < 100ms for 50 builders (no caching, single SQL)
- [ ] Optional: 5-min cache to handle reader polling

## Phase 7 — Rollout

- [ ] Add a "What's new" banner on the dashboard: "📡 RSS feeds for saved searches — try it"
- [ ] Tweet: "Every saved search in BuilderHunt now has a public RSS feed. Subscribe in Feedly, share with your team, embed anywhere."
- [ ] Monitor: feed fetches, share button clicks, sign-ups attributed to feed

## Edge cases to handle

- **Saved search with no keywords and no sources:** render empty feed with explanation. Don't 404.
- **Builder with very long bio:** truncate to 200 chars in description.
- **Special characters in search name:** XML-escape properly.
- **Search name contains HTML:** XML-escape (do NOT render as HTML).
- **Empty topics array:** match still works via sources.
- **User deletes the search:** feeds return 410 Gone (not 404) — clients can detect.

## Dependencies

- Existing: `savedQueries`, `builders` tables, `db`
- New package: none (use a 30-line template literal, no XML library)
- Schema migration: none

## Estimated effort

| Phase | Effort |
|-------|--------|
| 2 — RSS endpoint | S (3-4h) |
| 3 — HTML fallback | S (2-3h) |
| 4 — Frontend RSS button | S (2-3h) |
| 5 — Shareable URL | S (1-2h) |
| 6 — Verification | S (2-3h) |
| **Total** | **~1.5 days** |
