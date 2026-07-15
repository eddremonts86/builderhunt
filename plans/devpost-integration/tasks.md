# Tasks: Devpost Integration

## Phase 1: Scraping & Parsing Utilities
- [ ] Create `src/lib/sources/devpost.ts`
  - [ ] Implement search utility using fetch targeting `devpost.com/software/search`
  - [ ] Write HTML selectors / parse utilities to extract project team usernames
  - [ ] Implement profile lookup for target usernames targeting `devpost.com/{username}`
  - [ ] Map details (hackathons won, projects count, social links) to `RawBuilder` models
  - [ ] Parse technologies list into builder `topics`
- [ ] Set up unit tests under `tests/sources/devpost.test.ts` using static HTML profile fixtures

## Phase 2: Pipeline Integration
- [ ] Register `'devpost'` inside search types and schema in `src/lib/search.ts`
- [ ] Add `searchDevpost` to parallel execution tasks in `src/lib/search.ts`
- [ ] Update `deduplicateBuilders` to match and merge Devpost profiles with GitHub profiles using linked credentials

## Phase 3: Scoring Integration
- [ ] Add Devpost-specific logic in `src/lib/score.ts`
  - [ ] Score based on logarithmic completed projects count
  - [ ] Add Trophy Bonus (+15 to +25 pts) for winning hackathons
  - [ ] Score recency based on the last hackathon submission date

## Phase 4: UI & Styling
- [ ] Add Devpost brand icon to the icons asset pack
- [ ] Configure `.badge-devpost` style rules using dark grey/teal color accents
- [ ] Build `HackathonPortfolio` rendering component to list developer submissions in details panel

## Phase 5: Verification & Safety
- [ ] Test scraping performance and query latency locally
- [ ] Verify that HTTP errors or scraper failures are handled gracefully without blocking the global search pipeline
