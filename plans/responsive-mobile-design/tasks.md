# Responsive Mobile Design — Tasks

> **Status**: `pending`
> **Depends on**: nothing
> **Reality check**: see `spec.md` for the live-verified audit this plan is based on. Device matrix
> (use for every "Verify" step below): 375×667, 390×844, 430×932, 768×1024, 1024×768.

Execute top-to-bottom. Phase 1 is the highest-priority phase — it fixes the shared shell every
authenticated page renders through — and should land before the later phases' component sweeps,
since some of those components (e.g. `UserMenu`/`OrganizationSwitcher`) are triggered from the shell
this phase touches.

## Phase 0 — Decide the mobile nav pattern

- [ ] **Confirm the collapsed-nav approach**
  - Files: `plans/responsive-mobile-design/spec.md` (update the "Mobile nav decision" section with
    the final call)
  - Do: validate the spec's recommended default (hamburger sheet for Search/Sprints/Exports/Alerts,
    `OrganizationSwitcher`/`UserMenu` always visible) against real content — open the sheet mockup
    idea against all 5 nav items' labels/icons at 375px to confirm it doesn't itself get cramped.
    If a bottom tab bar or a different split reads better at the small-phone size, record that
    instead — this is a design decision task, not an implementation task.
  - Verify: a screenshot or quick static mockup at 375px showing the chosen pattern, attached to the
    decision note in spec.md.

## Phase 1 — Dashboard shell (blocks: every other authenticated page's nav)

- [ ] **Rebuild `DashboardLayout` topbar for narrow viewports**
  - Files: `src/modules/dashboard/ui/shell/DashboardLayout.tsx`
  - Do: below `md` (768px), collapse `Search`/`Sprints`/`Exports`/`Alerts` into the Phase 0-decided
    pattern (hamburger/sheet by default); keep `Dashboard`'s home-anchor pill, `OrganizationSwitcher`,
    and `UserMenu` always visible and always reachable without opening a second menu first. Remove
    reliance on `overflow-x-auto` as the *only* affordance — if any horizontal scroll remains for an
    edge case, it must ship with a visible scroll hint (gradient fade + on scroll-position update).
    Respect existing dark-glass tokens/motion conventions (`glass-topbar`, `motionTokens`) — this is
    a layout fix, not a re-skin.
  - Verify: screenshot at all 5 device-matrix sizes with the nav collapsed and expanded; confirm
    every one of Dashboard/Search/Sprints/Exports/Alerts/theme-toggle/org-switcher/user-menu is
    reachable by tap at 375×667 (the tightest size) with no horizontal scroll needed for primary
    nav. Confirm ≥1024px desktop layout is pixel-unchanged (screenshot diff by eye).

- [ ] **Clamp floating panel positioning to the viewport**
  - Files: `src/modules/dashboard/components/OrganizationSwitcher.tsx`,
    `src/modules/dashboard/components/UserMenu.tsx`
  - Do: both components' `reposition()` computes `right: window.innerWidth - rect.right` with no
    clamping — on the narrowest phones a panel opened near an edge can render partially off-screen.
    Clamp the computed `left`/`right`/`top` so the panel (accounting for its `min-w-[…]`) never
    exceeds the viewport bounds, with a small inset margin (e.g. 8-12px) matching this codebase's
    existing spacing scale. Keep the shared portal/fixed-position/reposition-on-scroll/outside-click/
    Escape pattern intact — this is a bounds-check addition, not a rewrite.
  - Verify: at 375×667, open each panel with the trigger positioned near the left edge and near the
    right edge (resize/scroll to force it); confirm the panel never clips off-screen in either case.

## Phase 2 — Data-heavy components (tables)

- [ ] **Wrap admin billing tables for horizontal scroll**
  - Files: `src/modules/admin/billing/DisputeQueue.tsx`, `src/modules/admin/billing/RefundQueue.tsx`
  - Do: wrap both `<table>` elements in an `overflow-x-auto` container (matching the one existing
    precedent for this pattern, `DashboardLayout`'s topbar, but here it's the *correct* use of the
    pattern — a genuinely wide data table, not primary navigation). Add a visible scroll-shadow/fade
    hint on the wrapper so the affordance is discoverable, unlike the topbar's silent version this
    plan is replacing.
  - Verify: at 375×667 and 768×1024, confirm both tables scroll horizontally with a visible hint,
    and that no column silently clips without a way to reach it.

- [ ] **Sweep for other unwrapped wide content**
  - Files: TBD — output of the sweep below
  - Do: grep `src/modules` and `src/routes` for any other raw `<table>`, or any fixed-width
    (`w-[…px]`, `min-w-[…px]` beyond the two floating-menu cases already fixed in Phase 1) elements
    that could overflow a 375px viewport; visually spot-check each hit at 375×667. Fix any genuine
    overflow found using the same wrap-and-hint pattern as the task above, or a `sm:`/`md:` stacking
    override if it's a flex/grid row rather than a table.
  - Verify: screenshot every fixed file at 375×667; no horizontal page-level scroll anywhere outside
    the two intentional table wrappers above.

## Phase 3 — Forms & compound control rows

- [ ] **Fix the search input/button/filter row**
  - Files: `src/modules/search/components/SearchPage.tsx` (the `flex gap-2` row at the keyword input)
  - Do: below `sm`, either stack the Search button and semantic-search toggle/filter icon below the
    input, or shrink the input's reserved right-padding (`pr-32`) so typed text isn't crowded out —
    whichever reads better in a live check. The `⌘K` hint already hides below `sm`
    (`hidden sm:flex`) — extend the same "hide the desktop-only affordance below sm" reasoning to
    whatever else doesn't fit.
  - Verify: at 375×667, type a realistic query ("rust async runtime") and confirm the full text
    remains visible and editable, with the Search button still reachable without scrolling the row.

- [ ] **Sweep settings/onboarding/builder-profile pages for the same compound-row pattern**
  - Files: `src/routes/_dashboard/settings/{team,billing,privacy}.tsx`,
    `src/modules/dashboard` onboarding components, builder profile page — exact file list is the
    output of this sweep
  - Do: visually check each at 375×667 and 768×1024 for the same "multiple controls forced into one
    non-stacking flex row" pattern found in `SearchPage.tsx`; apply the same stacking fix where found.
  - Verify: screenshot each swept page at 375×667; no clipped text, every control tappable.

## Phase 4 — Modals, dialogs, and the sprint wizard

- [ ] **Confirm shadcn Dialog + sprint wizard remain correct at narrow widths**
  - Files: `src/shared/components/Dialog.tsx` (or its shadcn equivalent), sprint wizard step
    components under `src/modules` (already spot-checked as reflowing correctly at step 1 — this
    task extends that check to steps 2-3 and any other modal-driven flows: delete confirmations,
    admin action modals, etc.)
  - Do: this is a lighter-touch verification task since the wizard's step 1 already reflows
    correctly today — the goal is confirming steps 2-3 and other dialogs don't regress that, not a
    rebuild. Fix only what's actually found broken.
  - Verify: screenshot every dialog/modal surface at 375×667 and 768×1024.

## Phase 5 — Confirmation sweep + regression guard

- [ ] **Full device-matrix pass across every representative page**
  - Files: none (verification-only task)
  - Do: using the iOS Simulator and Browser tool `resize_window`, walk the full page set — landing
    home, auth (sign-in/sign-up/forgot/reset), dashboard overview, search, sprints (list + wizard),
    exports, alerts, settings (team/billing/privacy), admin (metrics/users/plan-requests/incidents/
    changelog/roadmap/refunds/disputes/billing-ops), builder profile, onboarding — at all 5
    device-matrix sizes. Fix anything found that earlier phases didn't already cover.
  - Verify: no clipped content, no horizontal scroll outside the two intentional table wrappers, no
    control unreachable by tap, at any of the 5 sizes, on any page in this list.

- [ ] **Write the repeatable QA checklist**
  - Files: `docs/design/responsive-qa-checklist.md` (new)
  - Do: capture the device matrix, the page list from the task above, and the specific
    tools/commands used to check them (iOS Simulator `open_url`/`screenshot`, Browser tool
    `resize_window` presets) so a future PR touching layout can self-verify without re-deriving this
    plan's audit from scratch. Explicitly note: no automated viewport test suite exists or is
    planned — this checklist is the verification method by design (see spec.md non-goals).
  - Verify: the doc alone is the deliverable; no code verification needed.
