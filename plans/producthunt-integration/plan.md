# Plan: Product Hunt Integration

## Goal recap

Integrate Product Hunt as a data source to locate and score product-minded software creators ("makers") based on their launched products and community traction (votes, karma).

## Why this is a valuable addition

1. **High-intent credentials**: Launching a successful product on Product Hunt demonstrates end-to-end execution capacity (coding + shipping + marketing), which is a key trait of senior "builders".
2. **Cross-source linking**: The Product Hunt API natively exposes social fields like `gitHubUsername` and `twitterUsername` for many makers, enabling seamless profile stitching and deduplication within BuilderHunt.
3. **Alternative search angle**: Searching for developers by *what they have launched* (e.g. searching "database client" to find creators of database UI tools) is often more effective for talent discovery than searching bio keywords alone.

## Phases

### Phase 1: API Utilities (`src/lib/sources/producthunt.ts`)
- Implement a GraphQL client utility pointing to `https://api.producthunt.com/v2/api/graphql`.
- Read `PRODUCTHUNT_TOKEN` from environment variables.
- Write query functions:
  - Query 1: Search products ("posts") by keyword, extract makers, and return them as `RawBuilder` records.
  - Query 2 (Optional / Detail fetch): Resolve detailed maker statistics (karma, followers count) if not fully returned in Query 1.
- Parse product tags/topics to populate the builder's `topics` array.

### Phase 2: Pipeline Integration
- Add `'producthunt'` to the allowed list of sources in `src/lib/search.ts`.
- Integrate `searchProductHunt` inside the search handler.
- Map and deduplicate returned makers based on their `gitHubUsername` matching with existing `'github'` source hits.

### Phase 3: Scoring Adjustment (`src/lib/score.ts`)
- Implement Product Hunt-specific scoring rules:
  - **Popularity**: Logarithmic scaling of followers count (0-15 pts) + Logarithmic scaling of Product Hunt Karma (0-15 pts).
  - **Traction bonus**: Add score based on the highest-voted launched product:
    - >1000 votes: +15 pts.
    - >500 votes: +10 pts.
    - >100 votes: +5 pts.
  - **Recency**: Score based on the launch date of their latest product (0-20 pts).

### Phase 4: UI & Badging
- Add the Product Hunt SVG brand mark.
- Implement the `.badge-producthunt` styling classes using the signature brand color `#da552f`.
- Build a "Launched Products" component to render inside the builder sheet, showing their product names, taglines, and vote badges.

### Phase 5: Verification & Tests
- Create unit tests with mocked GraphQL responses under `tests/sources/producthunt.test.ts`.
- Verify query construction and rate-limit backoff handling.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **GraphQL rate limits (complexity points)** | High | Medium | Implement memory cache for query responses (TTL = 1 hour) and cache empty hits to prevent API spamming. |
| **Missing developer signal** | Medium | Low | Only index makers of products tagged under development-related categories (e.g., developer tools, design tools, productivity). |
| **Token expiration/quota exhaust** | Medium | High | Gracefully bypass Product Hunt source if the API returns a 401 or query quota errors, logging a warning instead of failing the search. |

## Rollback plan

- Keep the integration behind the `ENABLE_PRODUCTHUNT=false` feature flag.
- If the developer token expires or is rate-limited in production, the application will fallback to other sources without raising a runtime crash.
