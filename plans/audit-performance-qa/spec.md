# Specification: Performance & QA Validation

## Problem

The BuilderHunt landing page has multiple performance bottlenecks and testing gaps that risk degrading both Core Web Vitals scores and user experience:
1. **Slow Largest Contentful Paint (LCP)**: The hero graphic (`dashboard_mockup.jpg` / illustrations) is heavy and lacks modern compression (like WebP or AVIF).
2. **Cumulative Layout Shift (CLS) from Unsized Images**: The main dashboard image does not reserve layout space (`width`, `height`, or `aspect-ratio` are omitted), forcing the browser to recalculate the layout once the file finishes loading, causing shifts.
3. **Obsolete Lazy-Loading on Hero**: Implementing lazy loading (`loading="lazy"`) on the primary LCP image degrades the load speed because the browser waits to request the file.
4. **Font Layout Shifts**: Fonts load late, causing text flashes (FOIT/ FOUT) that trigger layout shifts.
5. **No Automated Integration Testing**: Core landing page features (footer links, pricing clicks, waitlist submissions, terms of service pages, and auth buttons) lack automated validation, risking broken routes in production.

## Goal

Optimize the Core Web Vitals to target an LCP under **2.5 seconds** and a CLS under **0.1**:
- Convert the new hero graphic `dashboard_mockup.jpg` to WebP format.
- Set explicit aspect ratio dimensions on the image tags to reserve visual space and prevent CLS.
- Implement high-priority eager loading (`fetchpriority="high"`, `loading="eager"`) for LCP images, and lazy loading for lower content.
- Implement font preloading tags.
- Build a Playwright-based E2E test suite to validate links, forms, and auth navigation.

## User stories

1. **As a visitor on a mobile connection**, I want the page to load fast and remain visually stable (no text jumping or card shifting) during load.
2. **As a visitor**, I expect all links, pricing calculators, and forms to function without broken actions.

## Technical details & optimizations

### 1. Image Asset Optimization
- Convert `public/images/dashboard_mockup.jpg` to WebP:
  - Output file: `public/images/dashboard_mockup.webp` (80% quality compression).
- Define image attributes inside the component:
  ```html
  <img 
    src="/images/dashboard_mockup.webp" 
    alt="BuilderHunt Dashboard Preview"
    width="1200"
    height="675"
    class="aspect-video w-full max-w-5xl rounded-2xl border border-zinc-800 shadow-2xl"
    loading="eager"
    fetchpriority="high"
    decoding="async"
  />
  ```

### 2. Font Loading Performance
Modify the header metadata in `src/routes/__root.tsx`:
- Add preloading link tags for primary web fonts (e.g. Google Fonts Outfit/Inter):
  ```html
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700&display=swap" as="style" />
  ```
- Use `font-display: swap` in the CSS stylesheet to fall back to system fonts immediately during load.

### 3. Playwright E2E QA Test Suite
Create a testing script `e2e/landing.spec.ts`:
- **Test 1: Link Integrity**: Scrapes all anchor tags (`<a>`) on the landing page, issues HEAD requests to verify status is 200 (no 404 broken links).
- **Test 2: Waitlist Submission**: Fills out the waitlist email field, clicks submit, and asserts that a success alert is shown and database records match.
- **Test 3: Authentication Redirection**: Clicks the main signup button and verifies the routing redirect lands on `/auth/sign-up`.
- **Test 4: Accordion Behavior**: Clicks the FAQ summary elements and verifies their `open` state toggles and heights adjust smoothly.

## Success metrics

- **LCP Performance**: Largest Contentful Paint completes in under 1.8s on desktop networks.
- **CLS Score**: Layout shift drops to 0.0, indicating absolute layout stability.
- **QA Automation**: Playwright pipeline covers 100% of critical conversion click paths, failing PR builds if landing components break.
