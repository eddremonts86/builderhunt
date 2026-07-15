# Tasks: Verified Portfolio Builder

## Phase 1: Database Setup & Fields
- [ ] Create database migration adding `portfolio_theme` and `portfolio_visibility` to `builders`
- [ ] Export updated schemas in `src/shared/lib/db/schema.ts`

## Phase 2: Public Route Setup & SEO
- [ ] Create public route `src/routes/portfolio.$username.tsx`
- [ ] Configure route loader to bypass login authentication checks
- [ ] Implement `meta` tags exporter parsing username and avatar URL for SEO search cards

## Phase 3: Bento Portfolio Layout
- [ ] Design the public template layout in `src/modules/builder-profile/components/PublicPortfolio.tsx`
  - [ ] Implement bento-grid structure
  - [ ] Integrate `DeveloperPersonaCard` (AI overview details)
  - [ ] Integrate `BuilderTimeline` (recent actions)
  - [ ] Embed floating chat Sandbox widget
  - [ ] Add visitor contact card component (email submission)

## Phase 4: Share Settings UI
- [ ] Build customization panel in `src/routes/_dashboard/me/index.tsx`
  - [ ] Add check selectors for timeline/sandbox visibility
  - [ ] Add repository whitelist filter checkboxes
  - [ ] Add theme selector dropdown (dark, light, minimal)
  - [ ] Implement copy link widget button with success notification

## Phase 5: Verification & Safety
- [ ] Test route authorization to ensure dashboard functions are blocked for public viewers
- [ ] Run Lighthouse audit locally to verify SEO tags compliance
