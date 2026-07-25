# Tasks: RSS Feeds per Saved Search

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Feed route + HTML fallback + rate limit + dashboard copy action +
> reader deep links all shipped and live-verified 2026-07-25.

## Delivered

- [x] **Public RSS endpoint** — Done: `src/routes/api/feeds/$searchId.ts`
      (`GET /api/feeds/{searchId}`; live `searchBuilders` snapshot, RSS 2.0,
      `atom:link rel="self"`, stable `guid: builderhunt-builder-{id}`,
      `Cache-Control: public, max-age=3600`).
- [x] **404 / 429 / 500 handling** — Done: missing search -> 404; in-memory 60 req/h/IP
      bucket -> 429; try/catch -> 500 plain text.
- [x] **HTML fallback for browsers** — Done: Accept-header negotiation in the same route;
      styled page with copy box, Feedly/Inoreader/NetNewsWire subscribe links, 5-item preview.
- [x] **XML safety** — Done: `escapeXml` on every interpolated field, CDATA descriptions,
      200-char bio truncation.
- [x] **Dashboard copy action** — Done: `SavedSearchRow` in
      `src/modules/dashboard/components/DashboardPage.tsx` ("Export & RSS" menu, copies
      `{origin}/api/feeds/{id}?format=rss` with clipboard-failure fallback text).
- [x] **No schema changes / no new packages** — Done: template-literal XML, existing
      tables only.

## Remaining

- [x] **Add reader deep links to the dashboard "Export & RSS" menu**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`
  - Do: below "Copy RSS feed URL" in `SavedSearchRow`, added two anchor items opening in a
    new tab: `https://feedly.com/i/subscription/feed/${encodeURIComponent(rssUrl)}` and
    `https://www.inoreader.com/?add_feed=${encodeURIComponent(rssUrl)}` (same URLs the
    HTML fallback in `src/routes/api/feeds/$searchId.ts` already uses).
  - Verify: `pnpm tsc --noEmit`/`pnpm eslint` clean. Live-verified in the browser: created a
    real saved search, opened the "Export & RSS" menu, confirmed both new menu items render
    (`role="menuitem"` anchors) with correctly percent-encoded `href`s pointing at the real
    signed feed URL (including its `token` query param) and `target="_blank"`.

## Future candidate (not scheduled)

A shareable "what I'm tracking" page requires a separate privacy/product decision and its own
spec revision. Saved searches remain private by default; it is not an executable task here.
