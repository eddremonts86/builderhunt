# Feature: RSS Feeds per Saved Search

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: The public feed route exists at `src/routes/api/feeds/$searchId.ts`
> (RSS 2.0 + HTML fallback + rate limiting) and the dashboard exposes a "Copy RSS feed URL"
> action (`src/modules/dashboard/components/DashboardPage.tsx`, `SavedSearchRow`). The
> real URL is `/api/feeds/{searchId}` (optionally `?format=rss`), **not** the `.xml` path
> earlier drafts promised.

## Problem

Email alerts have friction, saturation, and are not shareable. Developers still live in
RSS readers (Feedly, Inoreader, NetNewsWire). A public RSS URL per saved search turns each
search into a shareable endpoint and each user into a potential evangelist.

## Goal

Every saved search has a public RSS URL that works in any reader, needs no auth, and shows
a friendly HTML page when opened in a browser.

## Delivered

Shipped in `src/routes/api/feeds/$searchId.ts` and `DashboardPage.tsx`:

- **Route**: `GET /api/feeds/{searchId}` — public, no auth.
  - Loads the saved query (`savedQueries` table), 404 when missing.
  - Runs the live federated search (`searchBuilders` from `src/lib/search.ts`) with the
    saved keywords/sources/filters, `perPage: 50`.
  - Content negotiation: browsers (Accept `text/html` without `application/rss`) get a
    styled HTML page with a copyable feed URL, Feedly/Inoreader/NetNewsWire subscribe
    links, and a 5-item preview; everything else gets RSS 2.0 XML with
    `atom:link rel="self"`, CDATA descriptions, XML-escaping, and stable
    `guid: builderhunt-builder-{id}` per item.
  - `Cache-Control: public, max-age=3600` on both variants.
  - In-memory rate limit 60 req/h per IP (`x-forwarded-for` aware), 429 beyond.
  - Whole handler wrapped in try/catch -> 500 plain text (never leaks stack).
- **UI**: `SavedSearchRow` in `DashboardPage.tsx` has an "Export & RSS" menu with
  "Copy RSS feed URL" (copies `{origin}/api/feeds/{id}?format=rss`, clipboard fallback
  message included).

### Delivered semantics worth knowing

- The feed is a **live snapshot** of the current top-50 scored results, not a diff of
  "new builders since last poll". Readers deduplicate via the stable per-builder `guid`,
  which yields the intended "new items appear as new matches show up" behavior without
  any persistence.
- `pubDate` uses the builder's `lastSeen` when present, else "now".

## Remaining gaps (real)

1. **No reader deep links in the dashboard popover.** "Open in Feedly / Inoreader" links
   exist only on the HTML fallback page, not next to the copy action where the user
   actually is.
2. **The shareable "all my searches" page (original Phase 4) was never built.** Kept as an
   optional task; drop it if sharing sees no demand.

## Non-goals (unchanged)

Auth-gated feeds; feed personalization; JSON Feed / Atom variants; WebSub push; per-builder
feeds; feed analytics. Also explicitly **not** a diffing engine (see delivered semantics).

## Success metrics

- Feeds validate in the W3C feed validator and render in Feedly/Inoreader/NetNewsWire.
- Share of saved searches with >=1 feed fetch in 30 days: target 20%.
