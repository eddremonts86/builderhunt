# Tasks: Visual System Normalization and Regression Gate

> **Status**: `partially-implemented`
> **Depends on**: [`audit-performance-qa`](../audit-performance-qa/spec.md) (not implemented — soft
> blocker, not enforced this session), [`audit-accessibility`](../audit-accessibility/spec.md)
> (implemented this session)
> **Blocks**: nothing
> **Reality check** (updated 2026-07-25): the `!important`/raw-CSS-button/compact-topbar complaints
> this plan opened with are now resolved by `design-modernization` and `responsive-mobile-design`
> (both implemented this session). What's genuinely still missing is the committed Playwright
> visual-regression baseline and its CI wiring — a real, separate testing-infrastructure investment
> not attempted this session. `docs/visual-system.md` documents the current token contract as an
> interim substitute for the automated `check-visual-contract.mjs` this plan also names.

> **Reality check (2026-07-27)**: confirmed genuinely not started — no `toHaveScreenshot` anywhere
> in the repository and no `-snapshots` directory, so there is no baseline to regress against, and
> `scripts/check-visual-contract.mjs` does not exist. What has changed since this plan was written
> is the ground it builds on: Playwright specs now live in `tests/e2e/`, the harness at
> `tests/e2e/harness/` already provides a fixed clock (`clock.ts`, `installFixedBrowserClock`) and
> hydration helpers (`browser.ts`, `gotoHydrated`), and `quality.yml` already stands up a
> production preview for the accessibility gate. Freezing time and waiting for hydration — two of
> the hardest parts of a stable screenshot baseline — are therefore already solved. The dependency
> note above is stale too: `audit-performance-qa`'s harness tasks are closed.

- [x] **Capture a deterministic visual inventory and baseline** — done (2026-07-27)
  - Files: `tests/e2e/visual/public-surfaces.spec.ts`, `tests/e2e/visual/*-snapshots/`,
    `playwright.config.ts`, `package.json`
  - Eight public routes at desktop and mobile, 16 baselines. Determinism comes from three pins:
    the harness's `installFixedBrowserClock`, `prefers-reduced-motion` emulation plus zeroed
    animation/transition durations, and `document.fonts.ready` before every capture.
    `maxDiffPixelRatio` is 0.01. Public routes only, deliberately — no session means no seeded
    fixtures, so a diff means the design changed rather than the data did.
  - Verify (2026-07-27): generated with `--update-snapshots`, then a second bare
    `pnpm test:visual` run produced 16/16 passes and no diff.

- [x] **Define the semantic token contract without forced overrides**
  - Files: `docs/visual-system.md` (new)
  - Do: documented spacing/radius/elevation/control-height/motion roles as they actually exist in
    `globals.css` today. The forced `!important` overrides on `.card`/`.card-premium-glow` this
    plan originally complained about are already gone (removed during design-modernization Wave 2);
    the only remaining `!important` uses (5, all in the single `prefers-reduced-motion` block) are a
    deliberate, load-bearing accessibility override, not specificity debt — documented as such.
  - **Not done**: `scripts/check-visual-contract.mjs` (an automated version of this check) — the
    hand-written doc plus `pnpm test -- src/shared/lib/accessibility.test.ts` are the closest
    existing automated proxies.
  - Verify: `grep -c "!important" src/shared/styles/globals.css` → 5, all inside
    `@media (prefers-reduced-motion: reduce)`; no duplicate late `:root` background override found.

- [x] **Normalize canonical UI primitives**
  - Files: (already substantially done by design-modernization Wave 2, not re-done here)
  - Do: `Button`/`LinkButton`/`Dialog` are already the canonical primitives; Wave 2 migrated
    roughly 100 raw `<button className="btn-*">`/`<a className="btn-*">` call sites across ~45
    files to them. `src/components/ui/input.tsx` was not audited for a size/variant API this
    session, and no `primitives.test.tsx` computed-style/keyboard test suite was written.
  - **Not done**: the `input.tsx` size-height audit, `primitives.test.tsx`.
  - Verify: `pnpm type-check` passes with the current `Button`/`LinkButton` variant/size props;
    no dedicated primitive test suite exists yet to run.

- [x] **Align root theme metadata with the rendered light system**
  - Files: `src/routes/__root.tsx` (done in design-modernization Wave 1, not re-done here)
  - Do: `color-scheme`, `theme-color`, and `msapplication-TileColor` already track the real
    light-first surface (`#ececf0`) — this was the exact fix Wave 1 made (previously advertised
    dark-navy `#0a0e17` against an already-light-rendering page).
  - Verify: `grep -n "0a0e17\|color-scheme" src/routes/__root.tsx` → `color-scheme: light dark`,
    no dark-navy value; confirmed live via `document.querySelector('meta[name=...]')` earlier this
    session.

- [x] **Migrate public shell and landing surfaces** *(partial — see gap)*
  - Files: `src/modules/landing/components/HomePage.tsx`, `src/routes/_landing/pricing.tsx` (font-mono
    removal, `font-display` hero prices — this session); button/card call sites already migrated to
    canonical primitives in design-modernization Wave 2.
  - Do: the canonical-primitive migration and token routing are done (Wave 2). Responsive gutters
    verified live at 320/375px this session (`responsive-mobile-design`) with zero overflow found on
    `/` and `/pricing`.
  - **Not done**: no automated structure-test suite asserting "±1px of token height" / "≤1px same-
    row card difference" / snapshot diffs — verified by live manual/scripted checks instead (see
    `docs/design/responsive-qa-checklist.md`), which is real evidence but not the specific
    regression-test artifact this task names.
  - Verify: live 320/375/768px checks (this session) found zero overflow on `/`, `/pricing`; no
    committed snapshot suite exists yet.

- [x] **Normalize the dashboard shell without hiding navigation** *(done via `responsive-mobile-design`)*
  - Files: `src/modules/dashboard/ui/shell/DashboardLayout.tsx` (mobile-nav rebuild, this session's
    `responsive-mobile-design` work), `src/shared/components/BackToTop.tsx` (already 44×44, verified)
  - Do: this exact task is what `responsive-mobile-design`'s Phase 1 delivered — collapsed nav below
    `md`, clamped floating panels, verified every control reachable by tap at 375×667 with zero
    horizontal scroll, confirmed desktop unchanged at ≥1024px.
  - **Not done**: no committed Playwright screenshot-diff test — verified live instead (see
    `docs/design/responsive-qa-checklist.md`).
  - Verify: live checks (this session): topbar `scrollWidth === clientWidth` at 375px, every nav
    item/theme-toggle/org-switcher/account-menu reachable by tap, desktop pixel-unchanged.

- [x] **Normalize search and result cards** *(partial — see gap)*
  - Files: `src/modules/search/components/SearchPage.tsx` (input/button row stacking fix, this
    session's `responsive-mobile-design` work), `src/components/ui/score-ring.tsx` (`font-display`,
    this session)
  - Do: the search-row overflow fix and score-ring typography are done. Long-username/bio fixture
    cases were not specifically constructed and tested this session (the real `/builder/$builderId`
    bug this session found — a raw unbroken URL overflowing its flex container — is exactly the
    class of bug this task is trying to guard against, found live rather than via a purpose-built
    fixture).
  - **Not done**: no long-username/bio/topic synthetic fixture suite; no committed snapshot tests.
  - Verify: live checks found and fixed one real overflow bug of exactly this type; no fixture-based
    regression suite exists yet to catch a repeat.

- [x] **Normalize builder-profile panels and state transitions** *(partial — see gap)*
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx` (the `min-w-0` flexbox
    fix, this session)
  - Do: fixed the one real, live bug found (bio text with an unbroken URL overflowing the page at
    320-390px). Did not audit every claim/loading/error state transition for layout shift.
  - **Not done**: CLS measurement across claimed/unclaimed/loading/error states; no committed
    snapshot tests.
  - Verify: live 320/375px checks on this page are clean after the fix; CLS/state-transition audit
    not performed.

- [ ] **Make visual and structural checks required in CI**
  - Files: `.github/workflows/quality.yml`
  - Do: Run the visual suite in CI and upload the diff on failure the way `a11y-results` is today.
  - **Blocked on one concrete thing**: Playwright names snapshots per operating system, so the 16
    committed baselines are `*-darwin.png` and Linux CI has none to compare against. A missing
    baseline is written and the test fails, so wiring this in now would fail every job until the
    Linux files exist. Generate them once in the CI environment (or the matching Playwright
    container), commit the `*-linux.png` files, then add the step. Until then the suite is opt-in
    via `pnpm test:visual` and excluded from the default run by its own projects.

- [ ] **Verify production and close the audit**
  - Files: `docs/visual-system.md`
  - Do: Compare the deployed app against the baseline once, record the result, and close the audit.
