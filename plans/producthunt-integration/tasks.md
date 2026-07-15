# Tasks: Product Hunt Integration

## Phase 1: API Utilities
- [ ] Create `src/lib/sources/producthunt.ts`
  - [ ] Configure GraphQL client query requests using node fetch
  - [ ] Add `PRODUCTHUNT_TOKEN` environment variable read
  - [ ] Write GraphQL query for searching posts by keyword and resolving makers
  - [ ] Map maker node data structures to `RawBuilder` models
  - [ ] Parse product tags into builder `topics`
- [ ] Add mock query fixtures and tests under `tests/sources/producthunt.test.ts`

## Phase 2: Pipeline Integration
- [ ] Register `'producthunt'` in search schema properties in `src/lib/search.ts`
- [ ] Include `searchProductHunt` in the main search runner
- [ ] Update `deduplicateBuilders` to merge profiles using `gitHubUsername` cross-matching

## Phase 3: Scoring Adjustment
- [ ] Update `src/lib/score.ts` to score Product Hunt makers:
  - [ ] Score using logarithmic followers count and karma
  - [ ] Apply product votes boost (+5 to +15 pts)
  - [ ] Apply recency points based on latest launch date

## Phase 4: UI & Assets
- [ ] Add Product Hunt SVG logo in `src/components/icons`
- [ ] Define `.badge-producthunt` styling classes (using `#da552f` color theme)
- [ ] Create a `LaunchedProductsList` component to render maker's products in the detail view

## Phase 5: Verification & Tests
- [ ] Perform integration run on local environment
- [ ] Verify error handling and API fallback logic during credential failure or rate-limiting
