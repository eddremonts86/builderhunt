# Plan: RSS Feeds per Saved Search

## Goal recap

Every saved search becomes a public, shareable RSS feed. Users subscribe in their reader, share with teammates, embed anywhere. Converts every user into a potential evangelist.

## Why this is the highest-ROI feature

This is the **cheapest, highest-leverage** feature on the list:

1. **~1.5 days of work.** Single endpoint, one UI button, no schema changes.
2. **Zero new infrastructure.** No email service, no auth changes, no new packages.
3. **Virality built-in.** Public URLs are shareable. Every shared feed is a free acquisition channel.
4. **Retention by ritual.** RSS readers are part of the dev's daily routine. BuilderHunt becomes a recurring presence without the user having to remember to log in.
5. **No competitive risk.** No one else in this space has public RSS feeds for "find people who match this query". Differentiator.

## Phases

### Phase 0: Research (done in plan)

Confirmed: `savedQueries` and `builders` tables have everything we need. No migration.

### Phase 1: RSS endpoint

`GET /api/feeds/:searchId.xml`

- No auth (public)
- RSS 2.0 XML output
- `Content-Type: application/rss+xml`
- `Cache-Control: public, max-age=3600`
- Rate limit: 60/h per IP

**XML structure:** standard RSS 2.0 with `atom:link rel="self"`. Each item is a builder with title, link, pubDate (= lastSeen), and description with topics + sources + bio.

**Effort:** S (3-4h)

### Phase 2: HTML fallback

Same route, content-negotiate on `Accept` header. If a human visits the URL in a browser, show a nice HTML page with "Subscribe with Feedly / Inoreader / NetNewsWire" and a preview of the 5 most recent items. Reduces confusion when someone pastes a link to a non-dev.

**Effort:** S (2-3h)

### Phase 3: UI button

Extract `SavedSearchRow` component. Add `[RSS]` button. On click, popover/modal with:
- Read-only URL input
- Copy button (use `navigator.clipboard.writeText`)
- "Open in Feedly" deep link
- "Open in Inoreader" deep link
- Helper text: "Public. Anyone with the link can subscribe."

**Effort:** S (2-3h)

### Phase 4: Shareable "all my searches" URL (bonus, in scope)

A URL like `/share?u=<userId>&s=<id1>,<id2>,<id3>` that shows all the user's public searches with their RSS feed links. Great for the user's own blog or "what I'm tracking" page. Builds identity around the product.

**Effort:** S (1-2h)

### Phase 5: Verification

- Validate XML output with W3C feed validator
- Test in Feedly, Inoreader, NetNewsWire (manual)
- 404 for missing search
- 429 for rate limit
- HTML fallback for browsers
- Playwright tests for the three main responses

**Effort:** S (2-3h)

### Phase 6: Rollout

- In-app banner on dashboard for first 2 weeks: "📡 New: every saved search has a public RSS feed"
- Tweet the launch (it's shareable content)
- Optional: submit to https://github.com/feedland/awesome-rss-feeds or similar directories

**Effort:** S (1h)

## Dependency graph

```
Phase 0 (research) ──> Phase 1 (endpoint) ──┐
                                             ├──> Phase 3 (UI) ──> Phase 5 (verify) ──> Phase 6 (rollout)
                          Phase 2 (HTML) ─────┘
                          Phase 4 (share URL) ─────────────────────────────────────────┘
```

All phases after 0 can be parallelized if multiple agents.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Reader doesn't pick up the feed** | Low | Medium | Test in 3 major readers (Feedly, Inoreader, NetNewsWire) before launch. Add `<atom:link rel="self">` for proper discovery. |
| **Scraping / abuse** | Medium | Low | Rate limit (60/h/IP). 50-item cap. Cap is 50 builders — even with all data scraped, no harm. |
| **Privacy concern: user's saved searches become public** | Medium | Medium | Document clearly: "This feed is public because it shows builders that match your keywords — the data is from public activity, the saved search is your organization." If user wants to keep private, we don't expose the URL. |
| **Reader polling overloads DB** | Medium | Medium | 1h Cache-Control header. Optional: 5-min in-memory cache keyed by searchId. |
| **Empty search keywords** | Low | Low | Render feed with empty items + description "no keywords set". Don't 404. |
| **Builder with no `lastSeen`** | Low | Low | Use `createdAt` as fallback. |

## Rollback plan

- The endpoint is read-only. No data changes. If it gets abused, just block the route (1-line change).
- The UI button is a single component. If it confuses users, remove it (1-line change in DashboardPage).
- No migrations to revert.

## What this is NOT

- **Not a full-text feed.** No commits, no posts, no comments. Just "new builder matching X".
- **Not auth-gated.** It's a public feed. Auth-gated feeds are a different (later) feature.
- **Not a CMS / publishing platform.** No edit/delete/draft. The feed is auto-generated.
- **Not an outreach tool.** It surfaces new matches; it doesn't help you contact them.

## What this enables (downstream)

Once RSS works:
1. **JSON Feed variant** (https://www.jsonfeed.org/) — same data, JSON format. Some readers prefer it.
2. **Atom 1.0 variant** — for older readers.
3. **WebSub (PubSubHubbub)** — push instead of poll. Reduces DB load by 90%+ for popular feeds.
4. **Per-builder RSS** — `/api/feeds/builder/:id.xml` with new activity for that builder.
5. **Webhook** — same as WebSub but POST to user's URL. Power user feature.
6. **Email digest** — the "weekly summary" of new matches across all searches, generated server-side from the same query.
