# Plan: Lobsters Integration

## Goal recap

Add Lobsters as a high-signal source. Different from HN: small but high-quality, technical, less noise. Lobsters users are senior devs with strong opinions and quality contributions.

## Why this is the second pick

1. **Highest signal-to-noise of any source.** Lobsters is heavily moderated; spam and low-quality content is rare.
2. **Complementary to HN.** Lobsters skews more language/systems focused; HN is broader. Together, they cover the "thoughtful dev" segment.
3. **Public API exists** (no auth) but requires HTML scraping for user details. Pattern is similar to HN's.

## Phases

### Phase 0: Research (done in plan)

Confirmed:
- API at `https://lobste.rs/`
- JSON endpoints: `/hottest.json`, `/newest.json`
- User search: HTML only, no JSON
- User details: HTML at `/u/:username` (not JSON)
- OpenAPI spec exists

### Phase 1: Data model

No changes. Reuse `source: 'lobsters'`.

### Phase 2-3: Source + HTML parsing

New file `src/lib/sources/lobsters.ts`. The pattern is unusual:
- Fetch hottest + newest stories
- Extract submitters
- Fetch each user's profile HTML
- Parse bio, karma, tags

Requires `cheerio` (or `linkedom`).

### Phase 4-5: Pipeline + UI

Add to `search.ts`, add to `Source` type, add to default active sources, add brand icon (Lobsters red `#AC130D`).

### Phase 6: Scoring

Lobsters users don't have followers — only karma. Different scoring:
- Bio match (×10)
- Tag overlap (×5)
- Karma (log scale, ×2)
- Recency (×3 if active in 30d, ×1 otherwise)

### Phase 7-8: Verification + rollout

Manual + Playwright. Soft launch with monitoring. **Important**: HTML scraping is fragile to layout changes. If Lobsters redesigns, fallback to a hardcoded "notable users" list.

## Dependency graph

```
Phase 0 ──> Phase 1 (deps) ──> Phase 2 (source) ──> Phase 3 (parsing) ──┐
                                                                          ├──> Phase 7 (verify) ──> Phase 8 (rollout)
                                  Phase 4-5 (wire+UI) ──> Phase 6 (score) ─┘
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **HTML layout changes** | Medium | High | Cache aggressively, monitor for changes, fallback to notable users list |
| **No JSON for user search** | Certain | Medium | Document the constraint; iterate from stories (limited set of users) |
| **Rate limiting (undocumented)** | Low | Medium | Cache 10min, max 1 req/200ms |
| **Scraping violates ToS** | Low | Low | Lobsters is small and the data is public; contact them if concerned |
| **Lower coverage than HN** | Certain | Low | Lobsters is small (10k users) — this is a feature, not a bug |

## Rollback plan

- Feature flag: `ENABLE_LOBSTERS=false`
- Hide source pill from UI without removing integration
- No migrations to revert

## What this is NOT

- **Not a JSON-based integration.** HTML scraping required.
- **Not full-text search.** Limited to users in recent hot/new stories.
- **Not a real-time feed.** Cached, polled.

## What this enables (downstream)

Once Lobsters works:
1. **Tag-based browsing** — `/explore?tag=compilers` shows top users by tag
2. **"Stories they commented on"** — see a user's recent Lobsters activity
3. **Cross-source dedup** — same person on HN + Lobsters shown once
