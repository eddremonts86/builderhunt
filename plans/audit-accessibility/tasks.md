# Tasks: Accessibility release gate

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: The native FAQ, root skip link, global focus ring, dashboard target, and search live region already exist at the paths cited below. Unchecked tasks create a universal target, harden focus behavior, remediate measured failures, and make the audit repeatable.

- [x] **Use native FAQ disclosure controls**
  - Files: `src/modules/landing/components/FAQSection.tsx`
  - Do: Keep the shipped `<details>/<summary>` implementation and decorative chevron semantics.
  - Verify: `rg -n '<details|<summary|aria-hidden' src/modules/landing/components/FAQSection.tsx`

- [x] **Provide a visible global keyboard focus style**
  - Files: `src/shared/styles/globals.css`
  - Do: Keep the shipped `:focus-visible` ring as the baseline; later contrast assertions decide
    whether its colors need adjustment.
  - Verify: `rg -n ':focus-visible|skip-link' src/shared/styles/globals.css`

- [x] **Expose a root skip link and dashboard target**
  - Files: `src/routes/-root-components.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`
  - Do: Preserve the existing skip link and dashboard `main-content` target while the universal
    target task removes inconsistent/duplicate ownership.
  - Verify: `rg -n 'href="#main-content"|id="main-content"' src/routes/-root-components.tsx src/modules/dashboard/ui/shell/DashboardLayout.tsx`

- [ ] **Install and script the accessibility harness**
  - Files: `package.json`, `pnpm-lock.yaml`, `test/test-accessibility.mjs`
  - Do: Add `@axe-core/playwright`, a `test:a11y` script, deterministic public/auth route matrices,
    two viewports, hydration waits, selector-rich failures, and sanitized artifacts. Reject axe
    `critical` and `serious` violations; allow exclusions only through a dated inline exception.
  - Verify: `pnpm test:a11y` initially reports known failures and exits non-zero.

- [ ] **Create one universal skip target**
  - Files: `src/routes/-root-components.tsx`, `src/modules/landing/components/HomePage.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `test/test-accessibility.mjs`
  - Do: Wrap routed content in one `id="main-content"` target with `tabIndex={-1}` in the root
    document, remove duplicate ids from home/dashboard, and assert activation moves focus on public,
    auth, error, and authenticated pages.
  - Verify: `pnpm test:a11y -- --grep "skip link"` and `rg -n 'id="main-content"' src` returns one owner.

- [ ] **Harden the reusable dialog focus contract**
  - Files: `src/components/ui/dialog.tsx`, `src/components/ui/dialog.test.tsx`, `test/test-accessibility.mjs`
  - Do: Capture the opener, focus the first intentional control (or dialog), contain Tab/Shift+Tab,
    isolate background content, lock scroll, close on Escape, restore focus, and clean all effects.
    Add an optional initial-focus ref without changing existing call sites.
  - Verify: `pnpm test -- src/components/ui/dialog.test.tsx && pnpm test:a11y -- --grep "dialog"`.

- [ ] **Apply the focus contract to mandatory consent**
  - Files: `src/shared/components/TosModal.tsx`, `src/shared/components/TosModal.test.tsx`, `src/shared/components/CookieBanner.tsx`, `test/test-accessibility.mjs`
  - Do: Put initial focus inside the ToS modal, contain focus, make the background inert, preserve its
    non-dismissible Escape policy, and prevent the non-modal cookie banner from stealing focus.
  - Verify: `pnpm test -- src/shared/components/TosModal.test.tsx && pnpm test:a11y -- --grep "consent"`.

- [ ] **Measure and fix contrast pairs**
  - Files: `src/shared/styles/globals.css`, `src/shared/lib/accessibility.test.ts`, `src/modules/dashboard/components/DashboardPage.tsx`, `src/modules/search/components/SearchPage.tsx`
  - Do: Add a pure WCAG relative-luminance assertion for semantic text, badge, border, focus, error,
    hover, disabled, and selected-state pairs. Change only pairs that fail; document large-text and
    non-text thresholds in test cases.
  - Verify: `pnpm test -- src/shared/lib/accessibility.test.ts` passes every declared pair.

- [ ] **Measure and fix pointer target sizes**
  - Files: `src/shared/components/CookieBanner.tsx`, `src/shared/components/BackToTop.tsx`, `src/components/ui/dialog.tsx`, `src/modules/dashboard/components/OnboardingBanner.tsx`, `src/modules/dashboard/components/RecommendationsSection.tsx`, `src/modules/dashboard/components/DashboardPage.tsx`, `src/modules/search/components/SearchPage.tsx`, `test/test-accessibility.mjs`
  - Do: Measure every visible button/link rectangle in the route matrix; bring controls below 24x24
    CSS pixels into compliance and primary mobile actions to 44x44. Encode any SC 2.5.8 exception
    next to its assertion with rationale.
  - Verify: `pnpm test:a11y -- --grep "target size"` reports zero unexplained failures.

- [ ] **Repair names, roles, labels, landmarks, and announcements from the baseline**
  - Files: `src/modules/auth/components/SignInPage.tsx`, `src/modules/auth/components/SignUpPage.tsx`, `src/modules/search/components/SearchPage.tsx`, `src/modules/search/components/PersonResultCard.tsx`, `src/modules/dashboard/components/DashboardPage.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/shared/components/Header.tsx`, `test/test-accessibility.mjs`
  - Do: Fix only failures proven by axe/manual keyboard inspection. Associate errors/descriptions,
    preserve meaningful image alternatives, remove accessibility-tree duplicates, and announce async
    success/failure without unexpected focus movement.
  - Verify: `pnpm test:a11y -- --grep "semantics|announcements"`.

- [ ] **Respect reflow and reduced-motion preferences**
  - Files: `src/shared/styles/globals.css`, `src/modules/landing/components/HomePage.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `test/test-accessibility.mjs`
  - Do: Stop non-essential marquee/entrance/scroll animations under `prefers-reduced-motion`, avoid
    duplicated readable content, and remove two-dimensional page overflow at 320 CSS pixels/200%
    zoom while retaining intrinsically scrollable controls.
  - Verify: `pnpm test:a11y -- --grep "reflow|reduced motion"` plus manual 200% browser zoom.

- [ ] **Add the blocking CI quality workflow**
  - Files: `.github/workflows/quality.yml`, `package.json`
  - Do: On pull requests and `master`, install frozen dependencies, run lint/type/unit/build, migrate
    and seed PostgreSQL, start production preview, wait for `/api/health`, and run `test:a11y`.
    Upload sanitized traces on failure and require this workflow before deploy.
  - Verify: A pull-request run shows green `lint`, `type-check`, `test`, `build`, and `test:a11y` jobs.

- [ ] **Complete the manual assistive-technology release record**
  - Files: `docs/accessibility-verification.md`
  - Do: Record date, commit, tester, macOS/browser/VoiceOver versions, public signup/explore and
    authenticated search/save results, 200% zoom, 320px reflow, exceptions, owners, and expiry dates.
  - Verify: A reviewer reproduces both journeys using the document without a mouse.

- [ ] **Run final production-like smoke and record rollout evidence**
  - Files: `plans/audit-accessibility/spec.md`, `plans/audit-accessibility/plan.md`, `plans/audit-accessibility/tasks.md`
  - Do: Run all quality commands and the browser matrix against the built preview, verify the flag-on
    staging rollout, update the baseline with actual evidence, and mark status only after manual gates.
  - Verify: `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm test:a11y` exits 0 and the
    staging smoke has a dated link/commit in `docs/accessibility-verification.md`.
