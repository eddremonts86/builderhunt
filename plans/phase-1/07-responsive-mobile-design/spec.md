# Responsive Mobile Design

> **Status**: `partially-implemented`
> **Depends on**: nothing (pure frontend layout work; touches shared shell components every other
> plan's pages render through, so should land before large new UI surfaces are added on top of a
> broken shell)
> **Blocks**: nothing directly, but every future UI task inherits whatever shell/nav pattern this
> plan lands, so land Phase 1 early relative to other in-flight UI-heavy plans
> **Overlap note**: [`audit-visual-system`](../50-audit-visual-system/spec.md) (`partially-implemented`)
> already has an unchecked task, "Normalize the dashboard shell without hiding navigation," that
> targets the same file (`DashboardLayout.tsx`) with the same requirement ("at 320/390 px every nav
> action is reachable by keyboard and pointer"). That plan bundles this alongside canonical
> color/radius/token migration and new Playwright screenshot-diff CI infrastructure
> (`tests/e2e/visual-structure.spec.ts`) across 5 surfaces — a much larger, slower-moving effort. This plan
> is the narrower, immediately-actionable "make it responsive" slice, verified live rather than via
> a new CI snapshot suite (consistent with this project's standing direction against adding new e2e
> test files). A maintainer should decide whether to fold this plan's Phase 1 into
> `audit-visual-system`'s existing task once this plan's fix lands, mark that task there as
> superseded by this one, or keep both — this plan does not unilaterally change
> `audit-visual-system`'s status or tasks.
> **Reality check**: verified live against a real running dev server, both in the iOS Simulator
> (iPhone 17, Safari, `open_url` → `http://localhost:3010/...`) and via the Browser tool's
> `resize_window` (mobile 375×812, tablet 768×1024). This is not a theoretical audit — every issue
> below was seen on screen and traced to a specific file/line. The recent "dashboard redesign: dark
> glass theme, motion, topbar regroup" plan's own verification checklist claimed to check "320/390px
> widths keep every topbar action reachable" — that check did not actually catch this, or a
> subsequent change silently broke it. This plan does not re-litigate that plan's visual language
> (dark glass, motion tokens, accent system) — it only fixes layout/breakpoint behavior on top of it.

## Problem

BuilderHunt's authenticated dashboard shell — `src/modules/dashboard/ui/shell/DashboardLayout.tsx` —
renders one single-row flex pill navigation bar with `overflow-x-auto` as its *only* concession to
narrow viewports. On every real small-screen size tested (iPhone SE/14/15/16 class phones, and even
iPad Mini/Air **portrait**, 768px wide) this bar visibly overflows: the "Exports"/"Alerts" nav pills,
the light/dark theme toggle, the `OrganizationSwitcher`, and the `UserMenu` avatar (account, team,
billing, privacy, admin section, sign-out — everything) are pushed past the visible viewport edge
with **zero scroll affordance** — no gradient fade, no chevron, no indicator that there is more to
the right. A first-time mobile user has no way to discover that the account menu even exists, let
alone that scrolling the nav bar horizontally reveals it. This is not a cosmetic nit: on phone widths
the primary means of signing out, switching organizations, or reaching Team/Billing/Privacy/Admin is
effectively hidden.

Because `DashboardLayout` wraps every authenticated route, this single component's failure degrades
**every dashboard page** — overview, search, sprints, exports, alerts, settings, admin — regardless
of how well that page's own content reflows.

Spot-checking below the shell surfaced a second pattern: components built as fixed-width floating
panels or single, non-wrapping flex rows, with no `sm:`/`md:` stacking fallback:

- `OrganizationSwitcher.tsx:180` and `UserMenu.tsx:142` — both floating panels use a hardcoded
  `min-w-[220px]`/`min-w-[240px]` and `fixed` positioning computed from the trigger's bounding rect
  (`right: window.innerWidth - rect.right` in both components' `reposition()`). Neither clamps
  against the viewport edge, so on the narrowest phones a panel opened from a trigger near either
  edge can render partially or fully off-screen.
- `DisputeQueue.tsx:85` and `RefundQueue.tsx:110` — both render a raw `<table className="w-full …">`
  with no horizontal-scroll wrapper. On any phone-width screen this either clips columns or forces
  the whole page to scroll horizontally.
- `SearchPage.tsx:648` — the keyword input, Search button, semantic-search toggle, and filter icon
  are forced into one non-stacking `flex gap-2` row. The input's reserved right padding for its
  `⌘K` hint and clear button (`pr-32`) combined with the button's fixed width leaves almost no room
  for typed text on a 375px-wide screen — confirmed visually: typed/placeholder text is clipped.

Counter-evidence worth keeping in view while scoping this plan: most **content** pages (landing home,
the public `/explore` search demo, the sprint-creation wizard's step 1) already reflow correctly at
375-390px using ordinary Tailwind stacking (`grid-cols-1 sm:grid-cols-2`, block-level stacks). The
problem is concentrated in the **shared shell chrome** (topbar, floating menus) and a handful of
specific components that were never given a narrow-viewport treatment — it is not "the whole app is
unresponsive." Scoping and prioritization below reflect that: fix the shell once (it fixes every
authenticated page's top nav in one stroke), then sweep the remaining flagged components, then do a
systematic confirmation pass rather than a page-by-page rebuild.

## Goal

Every authenticated and public page is fully usable — every control reachable by tap, no clipped
text, no horizontal-scroll-as-navigation, no pinch-zoom required — across a concrete device matrix:

| Label | Viewport (CSS px) | Real device represented |
| --- | --- | --- |
| Small phone | 375×667 | iPhone SE (smallest current iPhone) |
| Standard phone | 390×844 | iPhone 14/15/16 |
| Large phone | 430×932 | iPhone Pro Max |
| Small tablet (portrait) | 768×1024 | iPad Mini / iPad Air portrait |
| Small tablet (landscape) | 1024×768 | iPad Mini / iPad Air landscape |

Desktop layout (≥1024px width in the *portrait/no-rotation* sense, i.e. the existing `lg:` breakpoint
and above) must not regress — this plan adds narrow-viewport handling, it does not redesign desktop.

## Non-goals

- Redesigning the dark-glass visual language, motion tokens, or accent system shipped by the
  "dashboard redesign" plan — this plan works within those tokens, not against them.
- Rebuilding pages that already reflow correctly today (confirmed: landing home, `/explore`, sprint
  wizard step 1) — only touch what the audit in this spec + Phase 0's sweep actually finds broken.
- A native mobile app, or any change to `plans/phase-1/02-production-infrastructure`'s deployment target.
- Any change to desktop (`lg:`/`xl:`) layout or breakpoint values.
- **New automated viewport/visual-regression tests (e.g. Playwright).** Per standing project
  direction earlier in this same working session, this repo does not add new e2e test suites for UI
  work — verification here is the same live-browser workflow already used throughout this session:
  the iOS Simulator (`mcp__Claude_Code_iOS_Simulator__control`) for a real Safari/WebKit check, and
  the Browser tool's `resize_window` for fast breakpoint sweeps. Phase 5 formalizes this as a written
  checklist, not a test file.

## Current responsive infrastructure (research)

- Tailwind v4, no custom breakpoints configured (`grep '@theme\|screens:'` across `globals.css` and
  the repo root returns nothing) — the framework defaults apply: `sm` 640, `md` 768, `lg` 1024, `xl`
  1280, `2xl` 1536.
- Every existing `grid-cols-3` (or higher) usage in `src/modules`/`src/routes` already pairs with a
  responsive override (`sm:grid-cols-*`/`md:grid-cols-*`) — grid-based content layout is generally
  in reasonable shape already; this is why the dashboard stat cards correctly reflow to 2 columns at
  375px in testing.
- Exactly one component in the entire `src/modules` tree uses `overflow-x-auto` as a layout fallback:
  `DashboardLayout.tsx`'s topbar. There is no existing "collapsed mobile nav" pattern (hamburger,
  bottom tab bar, sheet) anywhere in the codebase to reuse — Phase 1 has to establish one from
  scratch, so the decision below is deliberate rather than a follow of local precedent.
- `UserMenu.tsx`/`OrganizationSwitcher.tsx`/`AdminFlyout`-successor components already share one
  portal + fixed-position + reposition-on-scroll/resize + outside-click + Escape pattern (documented
  in `UserMenu.tsx`'s own top comment). Any positioning fix in Phase 1 should extend that shared
  pattern, not fork a second one.

## Mobile nav decision (confirmed, Phase 0 task 1)

**Confirmed as implemented**: collapse `Search`/`Sprints`/`Exports`/`Alerts` (everything except
`Dashboard`, the home anchor) behind a single hamburger-triggered sheet below `md`; keep
`Dashboard` as an icon-only pill, and `OrganizationSwitcher`/`UserMenu`/`ThemeToggle` always
visible. The originally-recommended default held, with one adjustment found only by building the
real thing at 375px rather than a static mockup: `OrganizationSwitcher`'s trigger also had to drop
its text label (`hidden md:inline` on the org name + chevron) below `md` — with the full 5-pill
row already collapsed to icon+hamburger, the switcher's `max-w-[120px]` name label was still wide
enough that the topbar overflowed and pushed `UserMenu`'s avatar trigger off-screen at 375×667.
Icon-only on both `OrganizationSwitcher` and `UserMenu` below `md` is what actually keeps every
control (Dashboard, hamburger, theme toggle, org switcher, account menu) reachable by tap with zero
horizontal scroll at the narrowest matrix size. Verified live via Browser tool `resize_window` at
375×667 signed in as the seeded admin: topbar `scrollWidth === clientWidth` (no overflow), the
hamburger sheet opens/positions/navigates/closes correctly, and desktop (`md`+) is unchanged (full
pill row still renders, gated by `hidden md:flex`).

## Verification approach

Every task in this plan is verified by: (1) `pnpm type-check`/`pnpm lint`, and (2) a live look at the
device matrix above via the iOS Simulator and/or Browser tool `resize_window` — screenshot each
affected page at each relevant size, confirm no clipped content, confirm every control is reachable
by tap alone. No new automated test files (see Non-goals). Phase 5 turns this into a repeatable
written checklist so future PRs don't have to rediscover the device matrix.
