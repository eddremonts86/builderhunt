# Specification: Accessibility release gate

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Native FAQ disclosure is already implemented in `src/modules/landing/components/FAQSection.tsx`; the global focus style and skip link exist in `src/shared/styles/globals.css` and `src/routes/-root-components.tsx`. The skip target is inconsistent outside the home and dashboard surfaces, and `src/components/ui/dialog.tsx` plus `src/shared/components/TosModal.tsx` do not trap, restore, or deliberately place focus.

## Problem

BuilderHunt has useful accessibility foundations, but it has no repeatable release gate and
cannot honestly claim WCAG 2.2 Level AA conformance. Automated testing is absent, the root skip
link can point to no element on landing subpages and auth routes, focus management is incomplete
for modal UI, and compact icon controls have not been measured against WCAG 2.2 target-size
requirements. A blanket replacement of color utility classes would be unsafe because contrast
depends on the foreground/background pair and state.

## Goal

Make accessibility a measured release criterion across public, authentication, and core
authenticated journeys. Close the known keyboard, focus, landmark, target-size, name/role/value,
status-announcement, and contrast gaps without changing product behavior.

This plan targets WCAG 2.2 Level AA. Passing automated checks is necessary but is not presented as
a certification or proof of complete conformance; the manual assistive-technology matrix remains
a release requirement.

## Baseline

Already delivered:

- [x] A visible-on-focus skip link exists in `src/routes/-root-components.tsx`, styled by
      `src/shared/styles/globals.css`.
- [x] Dashboard content has `id="main-content"` in
      `src/modules/dashboard/ui/shell/DashboardLayout.tsx`.
- [x] The home page has a skip target in `src/modules/landing/components/HomePage.tsx`.
- [x] FAQ questions use native `<details>/<summary>` in
      `src/modules/landing/components/FAQSection.tsx`.
- [x] A global `:focus-visible` treatment exists in `src/shared/styles/globals.css`.
- [x] Search loading status uses `aria-live="polite"` in
      `src/modules/search/components/SearchPage.tsx`.

Known gaps to verify and close:

- Landing subroutes render `src/routes/_landing/route.tsx` without a `main-content` id; auth,
  onboarding, public builder, and changelog routes also receive the root skip link without a
  guaranteed target.
- The reusable dialog closes on Escape but has no initial focus, focus containment, background
  inertness, or trigger-focus restoration. The blocking ToS modal has the same focus-management
  gap.
- Compact dismiss, clear, and action buttons use `p-1`/`p-1.5` in several files; CSS pixel bounds
  have not been tested at desktop and mobile breakpoints.
- There is no axe-based browser test, contrast unit test, keyboard smoke test, or accessibility CI
  workflow.

## Scope

### Automated route matrix

Test these unauthenticated routes at 375x812 and 1440x900:

- `/`, `/explore`, `/pricing`, `/blog`, `/legal/privacy`, `/auth/sign-in`,
  `/auth/sign-up`, and `/builders/:knownFixtureId`.

Test these authenticated routes with a deterministic seeded user:

- `/dashboard`, `/search`, `/alerts`, `/exports`, `/settings/billing`,
  `/settings/privacy`, and `/me`.

The fixture builder and user are created through the existing database seed path; tests must not
depend on live third-party source results.

### Required behavior

- Every rendered page has one primary content landmark and a working first-focusable skip link.
  Activating the link moves focus to the content target, not only scroll position.
- All interactive controls expose an accessible name, role, state, and error/description
  relationship where applicable.
- All functionality is operable by keyboard. Visual order and focus order agree. Menus and
  dialogs close on Escape; dialogs place focus, contain Tab/Shift+Tab, and restore focus.
- Dynamic search, save, delete, consent, and authentication outcomes are announced without moving
  focus unexpectedly.
- Text meets 4.5:1 contrast (3:1 for large text); components, focus indicators, and required
  graphical objects meet 3:1 in every relevant state.
- Pointer targets meet WCAG 2.2 SC 2.5.8's 24x24 CSS pixel minimum or a documented exception.
  Primary mobile actions target 44x44 CSS pixels as a product standard.
- Content remains usable at 200% zoom and 320 CSS pixels wide with no two-dimensional scrolling,
  except intrinsically two-dimensional content.
- Motion respects `prefers-reduced-motion`; marquee and decorative animations do not create a
  keyboard or reading-order duplicate.

## Architecture and exact surfaces

- Make the root target universal in `src/routes/-root-components.tsx` and remove duplicate target
  ids from `src/modules/landing/components/HomePage.tsx` and
  `src/modules/dashboard/ui/shell/DashboardLayout.tsx`.
- Keep accessibility primitives in `src/components/ui/dialog.tsx` and
  `src/shared/styles/globals.css`; feature components must consume those primitives rather than
  implement local focus traps.
- Bring the blocking legal modal in `src/shared/components/TosModal.tsx` to the same focus contract.
- Audit interactive controls in `src/shared/components/{Header,CookieBanner,BackToTop}.tsx`,
  `src/modules/dashboard/components/{DashboardPage,OnboardingBanner,RecommendationsSection}.tsx`,
  `src/modules/search/components/{SearchPage,PersonResultCard}.tsx`, and
  `src/modules/builder-profile/components/{BuilderProfilePage,OutreachCopilot}.tsx`.
- Add deterministic browser coverage in `tests/regression/test-accessibility.mjs` using
  `@axe-core/playwright`; add pure contrast/token assertions in
  `tests/unit/shared/lib/accessibility.test.ts`.
- Add `test:a11y` to `package.json` and run it in `.github/workflows/quality.yml` after starting a
  production preview against seeded PostgreSQL.

## User stories

- As a keyboard user, I can skip repeated navigation and operate every core journey with a visible
  focus indicator.
- As a screen-reader user, I hear the page structure, control state, validation errors, and async
  outcomes in a useful order.
- As a low-vision user, I can read text and controls, zoom to 200%, and use the app at a narrow
  viewport without losing actions.
- As a motion-sensitive user, I can request reduced motion and receive a stable experience.

## Non-goals

- Publishing a VPAT or claiming third-party certification.
- Rewriting product copy, navigation information architecture, or visual identity.
- Treating an axe or Lighthouse score as complete WCAG conformance.
- Hiding focus outlines for aesthetic reasons or replacing semantic HTML with ARIA replicas.

## Success metrics and acceptance gates

- Zero axe `critical` or `serious` violations on every route/viewport in the automated matrix;
  every suppressed rule has a linked issue, owner, rationale, and expiry date.
- 100% pass rate for scripted skip-link, keyboard-only search, FAQ, admin-menu, dialog focus-loop,
  Escape, and focus-restoration scenarios.
- 100% of audited text/token pairs pass their WCAG threshold; no target in the measured control
  inventory is below 24x24 CSS pixels without an SC 2.5.8 exception recorded in the test.
- No content loss or overlapping controls at 320 CSS pixels or 200% zoom in the manual matrix.
- Manual VoiceOver + Safari and VoiceOver + Chrome checks pass the public signup/explore and
  authenticated search/save journeys before rollout.
- `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`, and `pnpm test:a11y` pass in CI.

## Edge cases

- Route transitions must not leave focus on an unmounted link; page-title announcement and focus
  placement should be predictable without forcibly resetting focus during in-page interactions.
- Nested portals, the non-dismissible ToS modal, and the cookie banner must not compete for focus.
  The ToS modal takes precedence; the banner remains a non-modal region until the legal modal closes.
- Disabled controls are not counted as keyboard-operable actions but must remain understandable.
- External avatars with missing images retain meaningful adjacent names; decorative duplicates use
  empty alt text.
- Axe checks run after hydration and known async loading settles, with network calls stubbed where
  third-party data is irrelevant.

## Privacy and safety

Accessibility tests use synthetic accounts and fixture profiles only. Screenshots, traces, and CI
artifacts must not contain production emails, notes, session cookies, or builder private data.
