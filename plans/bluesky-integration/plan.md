# Plan: Bluesky Integration

## Goal recap

Integrate Bluesky as a data source in BuilderHunt. This allows indexing tech builders who share updates and "build in public" on the decentralized AT Protocol.

## Why this is a valuable addition

1. **Zero-friction public API**: The AT Protocol AppView allows querying public actors, posts, and feeds with standard HTTP requests, without requiring complex OAuth loops or paid credentials.
2. **Growing developer hub**: In 2026, Bluesky has become a primary hub for independent developers, open-source engineers, and tech founders moving away from proprietary platforms.
3. **Decentralized verification**: Many builders verify their identity using custom domains (e.g. `username.dev` or `username.com`), which gives high-integrity signal for matching and deduplicating their profiles with other platforms.

## Phases

### Phase 1: API Utilities (`src/lib/sources/bluesky.ts`)
- Implement fetch utilities pointing to the public AppView: `https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors`.
- Fetch detailed profile statistics (followers, posts count) using `app.bsky.actor.getProfile` for each search hit.
- Map the raw AT Protocol payloads to our standardized `RawBuilder` interface.
- Parse hashtags in bios or posts to populate `topics`.

### Phase 2: Pipeline Integration
- Update `src/lib/search.ts` to import `searchBluesky`.
- Register `'bluesky'` in the allowed list of sources.
- Add `'bluesky'` as a default active source or as an optional toggleable filter.

### Phase 3: Scoring Adjustment (`src/lib/score.ts`)
- Add specific scoring rules for Bluesky:
  - **Popularity**: Logarithmic scaling of followers count (0-30 pts).
  - **Recency**: Parse the `createdAt` of the developer's latest post to calculate days since last active (0-30 pts).
  - **Quality signals**: Boost score if the user handle is a custom domain name (verification signal, +5 pts) and if they have a complete profile (avatar, bio, displayName).

### Phase 4: UI and Brand Integration
- Add the Bluesky Butterfly SVG icon in `src/components/icons` (or equivalent location).
- Implement the `.badge-bluesky` CSS classes with the Celeste Blue theme (`#0085ff`).
- Render the recent Bluesky posts in the developer's profile detail view.

### Phase 5: Verification and E2E Tests
- Write Vitest unit tests for the mapper logic in `src/lib/sources/bluesky.ts`.
- Mock API responses using MSW or static fixtures.
- Add a Playwright test to verify search toggle interaction on the frontend dashboard.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **IP-based rate limits on public AppView** | Medium | High | Implement local Map cache in search wrapper and query with low concurrency limits. |
| **No native location/country metadata** | High | Low | Parse bio text for location strings (regex matching) or leave location blank. |
| **Fuzzy search noise** | Medium | Medium | Require a minimum threshold of developer-related keywords (e.g., code, build, developer) in bios for organic ranking. |

## Rollback plan

- Control the feature availability using an environment variable flag: `ENABLE_BLUESKY=false`.
- If the AppView rate limit gets triggered frequently on the production server, disable Bluesky in default active sources but leave it available as an opt-in toggle.
