# Tasks: Bluesky Integration

## Phase 1: API Utilities
- [ ] Create `src/lib/sources/bluesky.ts`
  - [ ] Implement query functions using fetch to `app.bsky.actor.searchActors`
  - [ ] Implement profile resolution using `app.bsky.actor.getProfile`
  - [ ] Map payloads to `RawBuilder` interface
  - [ ] Extract topics from hashtags in bio/posts
- [ ] Write Vitest unit tests for mapping logic in `tests/sources/bluesky.test.ts`

## Phase 2: Pipeline Integration
- [ ] Register `'bluesky'` in `SearchOptions` and sources list in `src/lib/search.ts`
- [ ] Integrate `searchBluesky` function in the parallel task engine of `src/lib/search.ts`

## Phase 3: Scoring Adjustment
- [ ] Update `src/lib/score.ts` to add Bluesky-specific metrics
  - [ ] Score based on logarithmic followers count
  - [ ] Score based on recency of the latest post
  - [ ] Add bonus points (+5) if the handle is a verified custom domain (contains dots and is not `.bsky.social`)

## Phase 4: UI & Styling
- [ ] Add Bluesky SVG brand icon to icons registry
- [ ] Implement `.badge-bluesky` styles in styling files (using `#0085ff` color theme)
- [ ] Render recent posts inside the builder details sheet/page component

## Phase 5: Verification & Testing
- [ ] Conduct smoke tests using local dev server with Bluesky enabled
- [ ] Add E2E Playwright test to verify filtering on the search dashboard
