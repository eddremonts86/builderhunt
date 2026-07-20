# Tasks: Visual System Normalization and Regression Gate

> **Status**: `partially-implemented`
> **Depends on**: [`audit-performance-qa`](../audit-performance-qa/spec.md), [`audit-accessibility`](../audit-accessibility/spec.md)
> **Blocks**: nothing
> **Reality check**: Tailwind v4 tokens and shared UI primitives are live. `.card` currently forces
> 24 px radius/shadows via `!important`, buttons also exist as raw CSS classes, the dashboard uses
> a compact fixed topbar, and no committed responsive/visual baseline protects these decisions.

- [ ] **Capture a deterministic visual inventory and baseline**
  - Files: `e2e/fixtures/visual-data.ts`, `e2e/visual-baseline.spec.ts`, `e2e/visual-structure.spec.ts`, `docs/visual-system.md`
  - Do: Seed synthetic public/auth states; freeze time/fonts/motion; capture `/`, `/pricing`, `/dashboard`, `/search`, and one builder profile at 390×844, 768×1024, and 1440×1000; inventory current computed radii, shadows, gutters, control heights, overflow, and same-row card edges.
  - Verify: `pnpm test:e2e -- e2e/visual-baseline.spec.ts e2e/visual-structure.spec.ts` produces stable identical results twice with `AI_DISABLED=true` and no real user data in artifacts.

- [ ] **Define the semantic token contract without forced overrides**
  - Files: `src/shared/styles/globals.css`, `docs/visual-system.md`, `scripts/check-visual-contract.mjs`
  - Do: Encode spacing/gutter/radius/elevation/control-height/motion roles from `spec.md`, remove the duplicate late `:root` background override and relevant `!important`, document source-brand exceptions, and reject new arbitrary raw values on audited files.
  - Verify: `node scripts/check-visual-contract.mjs` passes; computed-style assertions map every semantic class to its documented value and find no audited `!important`.

- [ ] **Normalize canonical UI primitives**
  - Files: `src/components/ui/button.tsx`, `src/components/ui/link.tsx`, `src/components/ui/input.tsx`, `src/components/ui/dialog.tsx`, `src/components/ui/index.ts`, `src/components/ui/primitives.test.tsx`, `src/shared/styles/globals.css`
  - Do: Make variants/sizes the only source of control appearance, cover 36/40/48 px heights, loading/disabled/focus/reduced-motion states, and allow page callers to add layout but not variant restyling.
  - Verify: `pnpm test -- src/components/ui/primitives.test.tsx` passes keyboard/state/computed-style assertions and `pnpm type-check` rejects unsupported variants/sizes.

- [ ] **Align root theme metadata with the rendered light system**
  - Files: `src/routes/__root.tsx`, `src/routes/-root-components.tsx`, `e2e/visual-structure.spec.ts`
  - Do: Set light-compatible `color-scheme`, theme color, and platform tile/status values from one exported token-safe constant; verify initial document paint and hydrated body use the same background.
  - Verify: browser assertions at `/` and `/dashboard` match meta theme color to computed body background and show no dark flash in a filmstrip trace.

- [ ] **Migrate public shell and landing surfaces**
  - Files: `src/shared/components/Header.tsx`, `src/shared/components/Footer.tsx`, `src/modules/landing/components/HomePage.tsx`, `src/modules/landing/components/FAQSection.tsx`, `src/routes/_landing/pricing.tsx`
  - Do: Replace ad hoc controls/panels with canonical primitives/tokens, apply shared responsive gutters, stretch only explicit comparison rows, keep source-brand colors, and preserve semantic/keyboard behavior.
  - Verify: structure tests show no overflow at 320/390/768/1440 px, named same-row cards differ by ≤1 px, CTAs are ±1 px of token height, and reviewed snapshots stay within 0.2%.

- [ ] **Normalize the dashboard shell without hiding navigation**
  - Files: `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `src/shared/components/BackToTop.tsx`, `e2e/visual-structure.spec.ts`
  - Do: Apply shared surface/elevation/gutter/control tokens to the fixed topbar and main area; preserve horizontally reachable navigation, account, admin, sign-out, tooltip, and back-to-top states at compact widths.
  - Verify: at 320/390 px every nav action is reachable by keyboard and pointer, main content is unobscured, page overflow is zero, and the screenshot diff passes.

- [ ] **Normalize search and result cards**
  - Files: `src/modules/search/components/SearchPage.tsx`, `src/modules/search/components/PersonResultCard.tsx`, `src/components/ui/score-ring.tsx`, `e2e/visual-structure.spec.ts`
  - Do: Use canonical panels/controls/gaps; make filters, badges, usernames, score, and actions wrap without collision; keep full user-generated values accessible rather than blindly clamping them.
  - Verify: fixture cases with long username/bio/topic and empty/error/loading states have no overlap, clipping, or page overflow at 320/390/768/1440 px and pass snapshots.

- [ ] **Normalize builder-profile panels and state transitions**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/modules/builder-profile/components/OutreachCopilot.tsx`, `src/shared/components/CodeStyleCard.tsx`, `src/shared/components/HygieneCard.tsx`, `e2e/visual-structure.spec.ts`
  - Do: Apply panel/control tokens to profile, notes, claim, outreach, code-style, and hygiene sections; preserve readable density and prevent claim/loading/error states from causing unintended surrounding shifts.
  - Verify: synthetic claimed/unclaimed/loading/error states show no overflow, controls meet token dimensions, layout-shift observer reports CLS ≤0.10 during state changes, and snapshots pass.

- [ ] **Make visual and structural checks required in CI**
  - Files: `.github/workflows/quality.yml`, `playwright.config.ts`, `package.json`, `pnpm-lock.yaml`, `docs/visual-system.md`
  - Do: Run contract, primitive, structural, accessibility-interaction, and Chromium screenshot tests in the fixed QA container; set `maxDiffPixelRatio: 0.002`; upload reviewed before/after/failure artifacts and document the intentional snapshot-update process.
  - Verify: an intentional 2 px radius, overflow, hidden focus state, and >0.2% image change each fail the appropriate job; approved unchanged baselines pass twice from clean checkout.

- [ ] **Verify production and close the audit**
  - Files: `docs/visual-system.md`
  - Do: Run read-only 390 and 1440 px production smoke for the five audited surfaces, confirm local fonts/theme metadata/no overflow, and link the CI run plus before/after evidence; record any untouched route exceptions as follow-up rather than expanding scope silently.
  - Verify: deployed screenshots and measurements satisfy every acceptance gate, contain synthetic/no private data, and remain stable after one application restart.
