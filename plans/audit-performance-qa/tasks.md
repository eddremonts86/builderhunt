# Tasks: Performance & QA Validation

## Phase 1: Image Conversion & Build Scripts
- [ ] Install `sharp` as a devDependency in the project
- [ ] Create image compression script `scripts/compress-images.ts`
- [ ] Run the script to generate WebP output for `public/images/dashboard_mockup.jpg`

## Phase 2: Aspect Ratio & Priority Tags
- [ ] Update `src/routes/_landing/index.tsx`
  - [ ] Add explicit width and height dimensions on the hero mockup image tag
  - [ ] Set `fetchpriority="high"` and `loading="eager"` on the hero mockup
  - [ ] Apply `loading="lazy"` tags to lower illustration graphics and testimonials avatars

## Phase 3: Font Optimization & Preload
- [ ] Update font loading rules in `src/routes/__root.tsx` to preload target styles
- [ ] Verify stylesheet includes `font-display: swap` overrides

## Phase 4: Playwright E2E Tests
- [ ] Create E2E test file `e2e/landing.spec.ts`
  - [ ] Write link crawler test (verify all anchors return status 200)
  - [ ] Write waitlist submission form workflow test
  - [ ] Write accordion open/closed toggle state verification test
  - [ ] Write clean-up teardown hooks to delete test waitlist subscribers from database

## Phase 5: Verification & Audits
- [ ] Run the production build command (`npm run build`)
- [ ] Execute Lighthouse audit locally on production preview configurations
