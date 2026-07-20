# Tasks: Performance and QA Release Gate

> **Status**: `partially-implemented`
> **Depends on**: [`public-landing-pages`](../public-landing-pages/spec.md)
> **Blocks**: [`audit-trust`](../audit-trust/spec.md), [`audit-visual-system`](../audit-visual-system/spec.md)
> **Reality check**: `playwright` is already a dev dependency and image dimensions/loading hints
> are present in `HomePage.tsx`. There is no configured Playwright/Lighthouse suite or quality gate,
> and the active desktop/mobile screenshots total about 1.7 MiB. Fresh checks on 2026-07-20 show
> 11 pricing type errors and one unused-variable ESLint error that must be cleared first.

- [ ] **Clear the known static-analysis baseline**
  - Files: `src/routes/_landing/pricing.tsx`, `test/test-landing-redesign.mjs`
  - Do: Implement the real `PLAN_PRICING` contract tracked by `pricing-optimization` and remove the unused `url` assignment from the landing redesign test. Do not add casts, disables, ignored files, or CI allowlists for either failure.
  - Verify: `pnpm type-check && pnpm exec eslint . --quiet` exits 0; the pricing route still renders monthly/annual prices and its canonical feature list.

- [ ] **Wire deterministic QA commands and dependencies**
  - Files: `package.json`, `pnpm-lock.yaml`, `README.md`
  - Do: Pin `sharp`, `@lhci/cli`, `@fontsource-variable/inter`, and `@fontsource/jetbrains-mono`; add `assets:build`, `assets:check`, `test:e2e`, `test:lighthouse`, and aggregate `qa` scripts. Document Docker, browser installation, test env, build/preview order, and exact commands.
  - Verify: `pnpm install --frozen-lockfile && pnpm exec playwright install --with-deps chromium && pnpm qa` succeeds in a clean CI checkout.

- [ ] **Create the production-preview browser harness**
  - Files: `playwright.config.ts`, `e2e/fixtures/auth.ts`, `e2e/fixtures/network.ts`, `.env.test.example`
  - Do: Start the 4173 production preview, isolate a disposable QA database/user, mock source/email egress, retain failure-only traces for seven days, redact auth material, and use Chromium with zero merge-gate retries.
  - Verify: `pnpm build && pnpm test:e2e -- --list` lists both suites without reading `.env.production` or contacting external APIs.

- [ ] **Cover critical public and authenticated paths**
  - Files: `e2e/critical-paths.spec.ts`, `e2e/dashboard.smoke.spec.ts`, `scripts/db/seed-admin.ts`
  - Do: Assert `/`, `/pricing`, `/explore`, `/legal/privacy`, `/status`, sign-up navigation, FAQ toggling, same-origin GET links, no page/console errors, and one seeded dashboard/search flow. Exclude external, mail, fragment, download, logout, and mutation links explicitly.
  - Verify: `pnpm test:e2e` passes twice consecutively with `AI_DISABLED=true` and the second run leaves no extra fixture rows.

- [ ] **Generate and enforce responsive screenshot assets**
  - Files: `scripts/optimize-images.ts`, `scripts/check-performance-budgets.mjs`, `public/images/search-desktop-640.avif`, `public/images/search-desktop-640.webp`, `public/images/search-desktop-1280.avif`, `public/images/search-desktop-1280.webp`, `public/images/search-desktop-1920.avif`, `public/images/search-desktop-1920.webp`, `public/images/search-mobile-360.avif`, `public/images/search-mobile-360.webp`, `public/images/search-mobile-720.avif`, `public/images/search-mobile-720.webp`
  - Do: Strip metadata, preserve verified aspect ratios, emit deterministic AVIF/WebP variants, and encode every size/byte budget from `spec.md`; keep source PNGs as compatibility fallbacks.
  - Verify: `pnpm assets:build && pnpm assets:check && git diff --exit-code -- public/images` passes; deliberate one-byte-over-budget and wrong-dimension fixtures make the checker fail.

- [ ] **Serve only the appropriate hero resource**
  - Files: `src/modules/landing/components/HomePage.tsx`, `e2e/performance-resources.spec.ts`
  - Do: Replace active screenshot tags with responsive `<picture>` sources, preserve correct dimensions/alt/loading semantics, add `fetchPriority="high"` to the LCP image, and ensure the hidden mobile crop is not fetched below `lg`.
  - Verify: `pnpm test:e2e -- e2e/performance-resources.spec.ts` proves selected URLs and initial image transfer ≤150 KiB at 390 px and ≤300 KiB at 1440 px, with zero horizontal overflow at 390/768/1440 px.

- [ ] **Self-host the existing fonts**
  - Files: `src/routes/__root.tsx`, `src/shared/styles/globals.css`, `package.json`, `pnpm-lock.yaml`, `e2e/performance-resources.spec.ts`
  - Do: Import only required Inter and JetBrains Mono weights, use WOFF2 plus `font-display: swap`, preload the above-fold Inter Latin face, and remove Google font preconnect/stylesheet links.
  - Verify: the resource test reports no `fonts.googleapis.com`/`fonts.gstatic.com` requests and computed styles retain Inter/JetBrains Mono with the documented system fallbacks.

- [ ] **Enforce Lighthouse budgets**
  - Files: `.lighthouserc.cjs`, `package.json`, `pnpm-lock.yaml`
  - Do: Run three mobile-throttled production-preview audits for `/`; assert performance ≥0.90, accessibility ≥0.95, LCP ≤2.5 s, CLS ≤0.10, TBT ≤200 ms, and transfer ≤900 KiB.
  - Verify: `pnpm test:lighthouse` passes three consecutive CI runs; lowering any assertion below the measured result makes the command fail.

- [ ] **Gate pull requests and deployment**
  - Files: `.github/workflows/quality.yml`, `.github/workflows/deploy.yml`
  - Do: Run frozen install, lint, type-check, unit, assets, build, browser, and Lighthouse jobs on pull requests; make the existing master deploy job depend on equivalent quality checks; upload only redacted failure artifacts.
  - Verify: a test branch with an intentional failing unit and browser assertion cannot reach the deploy job; a green run produces a quality artifact and deployment UUID.

- [ ] **Add read-only production smoke and record the baseline**
  - Files: `.github/workflows/deploy.yml`, `docs/operations/performance-qa.md`
  - Do: After Coolify succeeds, check `/api/health`, `/`, `/pricing`, and `/auth/sign-up` status/content without authentication or mutation. Record before/after transfer and three-run Lighthouse medians plus branch-protection evidence.
  - Verify: the workflow fails against an incorrect health/body expectation and passes against production; the run URL and metrics are linked from the operations record.
