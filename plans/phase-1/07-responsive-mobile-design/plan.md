# Responsive Mobile Design — Delivery Plan

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Reality check**: see [`spec.md`](./spec.md) for the live-verified audit (iOS Simulator + Browser
> tool `resize_window`) this plan is based on.

## Guiding principles

1. **Fix the shell before the pages.** `DashboardLayout` wraps every authenticated route; its
   topbar's overflow bug degrades every one of those pages regardless of how well that page's own
   content reflows. Phase 1 lands first and alone fixes nav/account-access on every dashboard page.
2. **Confirmed-broken over assumed-broken.** Most content pages already reflow correctly at
   375-390px (landing home, `/explore`, sprint wizard step 1) — this plan does not rebuild what
   already works. Every later phase's task list starts from a live-verified finding, and sweep tasks
   are scoped to "find and fix what's actually broken," not a wholesale redesign.
3. **Extend existing patterns, don't fork new ones.** `UserMenu`/`OrganizationSwitcher` already share
   one portal + fixed-position + reposition + outside-click/Escape pattern; the viewport-clamping fix
   extends it. The one existing `overflow-x-auto` precedent (currently misused for primary nav) gets
   correctly reused for the two admin tables that are genuinely wide data, with a visible affordance
   the original usage was missing.
4. **No new automated test surface.** Verification is the same live-browser workflow (iOS Simulator,
   Browser tool resize) already used to build this plan's evidence base, formalized as a written
   checklist in Phase 5 rather than a Playwright viewport suite — consistent with this project's
   standing direction against adding new e2e test files for UI work.

## Phase order

### Phase 0 — Decide the mobile nav pattern
Validate the spec's recommended collapse (hamburger/sheet for the 4 non-home nav pills; org-switcher
and user-menu always visible) against the actual content at 375px before Phase 1 builds on it.

### Phase 1 — Dashboard shell (blocks: every other authenticated page's nav)
Rebuild `DashboardLayout`'s topbar to the Phase 0 decision; remove `overflow-x-auto` as primary nav's
only affordance. Clamp `OrganizationSwitcher`/`UserMenu` floating-panel positioning to the viewport so
neither can render off-screen on the narrowest phones.

### Phase 2 — Data-heavy components (tables)
Wrap the two unwrapped admin billing `<table>`s (`DisputeQueue.tsx`, `RefundQueue.tsx`) in a
horizontal-scroll container with a visible hint. Sweep for any other unwrapped wide content the
initial audit didn't surface.

### Phase 3 — Forms & compound control rows
Fix `SearchPage.tsx`'s cramped input/button/filter row (confirmed clipping typed text at 375px).
Sweep settings, onboarding, and builder-profile pages for the same pattern.

### Phase 4 — Modals, dialogs, and the sprint wizard
Lighter-touch verification pass: confirm sprint wizard steps 2-3 and other modal-driven flows (delete
confirmations, admin actions) don't regress the step-1 behavior already confirmed correct.

### Phase 5 — Confirmation sweep + regression guard
Walk the full page inventory across the 5-size device matrix; fix anything earlier phases missed.
Write `docs/design/responsive-qa-checklist.md` so future layout PRs can self-verify without
re-deriving this plan's audit.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Collapsed nav hides a control users relied on finding via horizontal scroll | Low | Medium | Org-switcher/user-menu stay always-visible by design; only the 4 secondary nav pills collapse, and they gain an explicit, visible trigger instead of an invisible scroll affordance |
| Viewport-clamping breaks the existing reposition-on-scroll/resize behavior | Low | Medium | Extend the shared pattern with a bounds check only; verify scroll/resize repositioning still fires correctly at all 5 matrix sizes before/after |
| Fixing one component regresses desktop (≥1024px) layout | Low | High | Every task's Verify step explicitly includes an unchanged-desktop screenshot check |
| Sweep tasks (Phase 2/3's "other unwrapped content") balloon scope unpredictably | Medium | Low | Sweep tasks are capped to what a grep + visual spot-check at 375px actually surfaces — no open-ended redesign |

## Rollback plan

- Every task is a scoped, independent component-level change (topbar, one panel's positioning logic,
  one table wrapper, one form row) — revert the specific commit if a regression surfaces, no
  cross-cutting rollback needed.
- No schema, migration, or data changes anywhere in this plan — purely frontend layout/CSS/component
  logic, so rollback is a plain git revert with no data-safety concerns.

## Release gate

1. `pnpm type-check` and `pnpm lint` clean after every task.
2. Every task's live-browser verification (iOS Simulator and/or Browser tool `resize_window`) passed
   at the relevant device-matrix sizes, screenshotted.
3. Desktop (`lg:`/`xl:`) layout confirmed pixel-unchanged for every touched component.
4. Phase 5's full-page-inventory sweep passed with no outstanding clipped/unreachable content.
5. `docs/design/responsive-qa-checklist.md` exists and is usable standalone by a future PR without
   needing this plan's spec.md for context.
