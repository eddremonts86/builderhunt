# Plan: Performance & QA Validation

## Goal recap

Optimize Largest Contentful Paint (LCP) and Cumulative Layout Shift (CLS) on the landing page, configure preloading for fonts, enforce explicit aspect-ratio sizes, and build a Playwright E2E integration test suite.

## Why this is a valuable addition

1. **Ensures Rapid First Impressions**: Slow page loads directly reduce conversion. Lowering LCP under 2s increases user retention and sign-up conversions.
2. **Layout Stability (No Shifts)**: Omitted image heights cause layout jumps that frustrate users. Reserving aspect ratio dimensions ensures a smooth load experience.
3. **PR Build Safety Gates**: Having automated E2E tests prevents regressions from entering production, ensuring all landing buttons, forms, and auth links remain functional.

## Phases

### Phase 1: Image Compression Script
- Since macOS `sips` lacks default WebP output configurations, implement a lightweight Node.js script using the standard `sharp` library to compress and convert the main JPG images:
  - Create a development utility `scripts/compress-images.ts` that scans the `public/images/` folder and outputs optimized WebP versions.

### Phase 2: Markup Image Sizing & Priority Tags
- Edit `src/routes/_landing/index.tsx`.
- Replace the mockup image wrapper. Update it to include `width={1200}`, `height={675}`, `aspect-ratio: 16/9`, `fetchpriority="high"`, and `loading="eager"`.
- Apply `loading="lazy"` tags to the testimonials avatars and icons lower down the page.

### Phase 3: Font Optimization & Preloading
- Edit `src/routes/__root.tsx`.
- Add `<link rel="preload">` configurations for Google Fonts Outfit and Inter.
- Update global CSS rules to verify `font-display: swap` is active on imports.

### Phase 4: Playwright E2E Tests Setup
- Initialize Playwright configs.
- Create E2E test file: `e2e/landing.spec.ts`.
- Write test assertions:
  - Validate that guest search redirects to `/search`.
  - Validate that waitlist form submission inserts the email address and returns a success status.
  - Verify that no links return a 404 response.

### Phase 5: Verification & Web Vitals Audit
- Build the production bundle locally: `npm run build` and `npm run preview`.
- Run Lighthouse audits on the preview port (usually port 4173) to verify compliance metrics (LCP < 2s, CLS < 0.05).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Lighthouse reports slower score on mobile networks** | Medium | Medium | Compress all images aggressively. Reduce the number of external scripts loaded in the header. |
| **Playwright tests fail in CI due to database state** | Medium | Low | Ensure the waitlist E2E test deletes its test subscriber record upon completion to prevent duplicate key failures in subsequent runs. |

## Rollback plan

- Performance changes are static structure enhancements and test suites, requiring no rollback pipelines.
