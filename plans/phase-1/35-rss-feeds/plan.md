# Plan: RSS Feeds per Saved Search

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Endpoint (`src/routes/api/feeds/$searchId.ts`), HTML fallback, rate
> limiting, and the dashboard copy action all shipped. Remaining: reader deep links in the
> dashboard and the optional share page.

## Executed phases (record)

1. **RSS endpoint** — `src/routes/api/feeds/$searchId.ts`: public GET, live
   `searchBuilders` snapshot, RSS 2.0 with self-link and stable guids, 1h cache header,
   60 req/h/IP in-memory rate limit, 404/429/500 handling.
2. **HTML fallback** — same route, Accept-header negotiation; styled page with copy box,
   Feedly/Inoreader/NetNewsWire links, 5-item preview.
3. **UI copy action** — `SavedSearchRow` in
   `src/modules/dashboard/components/DashboardPage.tsx`: "Export & RSS" menu with
   "Copy RSS feed URL".

## Remaining phases

### Phase A — Reader deep links in the dashboard menu

Add "Open in Feedly" (`https://feedly.com/i/subscription/feed/{encoded}`) and "Open in
Inoreader" (`https://www.inoreader.com/?add_feed={encoded}`) items next to the existing
copy action, reusing the exact URLs already emitted by the HTML fallback page.

### Phase B (optional) — Shareable "what I'm tracking" page

Public page listing a user's chosen saved searches with their feed links. Needs an explicit
opt-in flag per search (privacy: saved searches are private by default), so it is NOT just
UI — park it unless users ask for sharing.

## Risks

| Risk                                   | Likelihood | Impact | Mitigation                                                              |
| -------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------- |
| Reader polling triggers live searches  | Medium     | Low    | 1h `Cache-Control` + the 5-min search cache in `search.ts` absorb polls |
| In-memory rate bucket resets on deploy | Certain    | Low    | Acceptable; worst case is a brief rate-limit reset                      |
| Share page leaks private search intent | Medium     | Medium | Phase B requires per-search opt-in flag before any listing              |

## Rollback plan

Endpoint is read-only; blocking the route is a one-line change. The UI action is a single
menu item. No migrations.
