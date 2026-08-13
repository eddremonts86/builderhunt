# Visual system — semantic token contract

This documents the **current, real** design-token contract in `src/shared/styles/globals.css`
after `design-modernization` (all 3 waves) and this pass of `audit-visual-system`. It's a
description of what the code actually does, not an aspirational spec — if this document and
`globals.css` ever disagree, the code is the source of truth and this file needs updating.

See also [`DESIGN.md`](../DESIGN.md) (the fuller design-system narrative: palette, typography,
component philosophy, do's/don'ts) — this file is the narrower "spacing/radius/elevation/motion
contract" companion the `audit-visual-system` plan asks for.

## Spacing

- Base unit: 4px (Tailwind's default scale, used directly — no custom spacing scale).
- Page gutters: `.container` (max-width 1200px) and `.container-narrow` (max-width 800px, for
  reading-width content) both use `1.25rem` (20px) horizontal padding at every size — there is no
  separate `<768`/`768-1023`/`≥1024` breakpoint-specific gutter value; the container's own
  max-width plus `mx-auto` centering is what changes at each breakpoint, not the padding.
- Section rhythm: `.section` (5rem/80px vertical padding, 3rem/48px below 768px) and `.section-lg`
  (7rem/112px, 4rem/64px below 768px).

## Radius

One consistent scale, used by role rather than by component:

| Role | Value | Used by |
| --- | --- | --- |
| Control (buttons, inputs) | `8px` | `.btn-*`, `.input-field`, badges' pill shape uses `9999px` instead |
| Large control | `10px` | `.btn-lg` |
| Glass/shell panel | `20px` | `.glass-panel` (dashboard shell/menus only — see Elevation) |
| Card | `24px` | `.card`, `.card-glow`, `.card-premium-glow` |
| Pill | `9999px` | badges, eyebrows, the segmented `ThemeToggle` |

No arbitrary one-off radius values remain in the audited component files (`globals.css`,
`src/components/ui/*`, the shared shell) — every `border-radius` maps to one of the roles above.

## Elevation

Flat-by-default with two named elevated roles — no ad hoc per-page shadow values:

- **Card ambient** (rest state): `0 10px 30px -15px rgba(24,24,27,0.03), 0 1px 3px rgba(24,24,27,0.01)`
  (dark mode: `rgba(0,0,0,0.5)` / `rgba(0,0,0,0.3)`).
- **Card premium hover**: accent-tinted lift, `0 12px 30px -10px rgba(224,115,56,0.15)`, only on
  `.card-premium-glow:hover`.
- **Glass shell**: `0 10px 30px -15px rgba(24,24,27,0.08), 0 1px 3px rgba(24,24,27,0.03)` (dark:
  `0 8px 32px -12px rgba(0,0,0,0.4)`) — reserved for the dashboard shell (topbar, `UserMenu`,
  `MobileNavSheet`). Confirmed via `grep -rln "glass-panel\|backdrop-filter" src` → exactly 3 files
  (the two shell components plus `globals.css`'s own definitions).

`!important` in `globals.css`: 5 remaining uses, all inside the single
`@media (prefers-reduced-motion: reduce)` block (forcing `animation-duration`/
`transition-duration`/`scroll-behavior` to near-zero regardless of component-level styles) — a
deliberate, load-bearing exception for accessibility, not leftover specificity debt. `.card`'s
former `!important` on border/shadow (the plan's original complaint) is gone.

## Control height

- Default control: `36px` (`h-9`, e.g. `OrganizationSwitcher`/`UserMenu` triggers).
- Small: `32px` (`.btn-sm`, `h-8`, `ThemeToggle` segments).
- Large: `44px` (`.btn-lg`, `h-11`, the search page's semantic-toggle/filter triggers, `BackToTop`)
  — also the WCAG 2.5.8 "enhanced" pointer-target size, so every primary large control clears it by
  construction.

## Motion

- Durations (`src/shared/lib/motion/tokens.ts`): `fast` 0.18s, `normal` 0.32s, `slow` 0.5s. Easing:
  `smooth` (`[0.22,1,0.36,1]`) for entrances, `sharp` (`[0.4,0,0.2,1]`) for quick UI feedback.
- CSS-driven animations (`.animate-fade-in`, `.animate-fade-in-up`, the landing marquee) are
  globally zeroed under `prefers-reduced-motion: reduce` (see Elevation's `!important` note).
- Framer Motion surfaces gate their own entrance animation via `useReducedMotion()`:
  `DashboardLayout`, `UserMenu`, `MobileNavSheet`, `BackToTop`, and `DashboardPage`'s stats-grid
  stagger (the last one was a real gap found and fixed this session — it played unconditionally
  before).
- The landing marquee (30s linear infinite) pauses on hover
  (`.marquee-container:hover .marquee-content`).

## Typography

- Body: Inter (self-hosted variable woff2, weights 100-900).
- Display (hero/stat figures only, via the `font-display` Tailwind utility): Fraunces 700
  (self-hosted, added this session) — dashboard stat cards, pricing plan prices, the match/hygiene
  score ring. Not applied to the base body face.
- Code/keys only: JetBrains Mono, via `.kbd` or explicit `font-mono` — contained to genuine
  code/keyboard-shortcut contexts after this session's sweep (`font-mono` no longer appears in
  marketing/discovery copy).

## Primitives

`src/components/ui/button.tsx` (`Button`), `src/components/ui/link.tsx` (`LinkButton`), and
`src/components/ui/dialog.tsx` (`Dialog`, Radix-based) are the canonical interactive primitives.
Design-modernization's Wave 2 migrated the overwhelming majority of raw `<button className="btn-*">
`/`<a className="btn-*">` call sites across the app to these components (roughly 100 call sites
across ~45 files) — a small number of native elements remain deliberately unconverted where the
component genuinely doesn't fit (external `target="_blank"` anchors, a button whose fully custom
color/border styling would conflict with a forced variant class) or where a `ref` requirement
(`Button` isn't `forwardRef`) made the native element the safer choice (`TosModal`'s Accept button).

## Root theme metadata

`src/routes/__root.tsx`'s `color-scheme`/`theme-color`/`msapplication-TileColor` track the real
light-first surface (`#ececf0`, matching `--color-bh-bg`) — fixed in design-modernization Wave 1,
which previously advertised a dark-navy (`#0a0e17`) value against a page that already renders
light-first.

## Known gaps (not done this session)

- **No committed visual-regression baseline.** `plans/implemented/phase-1/50-audit-visual-system/tasks.md`'s "Capture a
  deterministic visual inventory and baseline" task (Playwright screenshot specs pinning `/`,
  `/pricing`, `/dashboard`, `/search`, and a builder profile at three viewports) was not built this
  session — it's a real, separate testing-infrastructure investment (synthetic fixtures, frozen
  time/fonts/motion, `maxDiffPixelRatio` tuning) that deserves dedicated attention rather than a
  rushed pass at the end of an already large session covering three other plans first.
- **No CI wiring for visual/structural checks** — follows from the above; nothing to wire in yet.
- This document itself is the "token contract" deliverable; the mechanical `check-visual-contract.mjs`
  script the plan also names was not built (this doc + `pnpm test -- src/shared/lib/accessibility.test.ts`
  + `pnpm test:a11y` are the closest existing automated proxies for "does the contract hold").


## Tables — what shipped (phase 3)

The code wins where this section and `DataTable.tsx` disagree; this describes what is there.

| Decision | Value | Where |
| --- | --- | --- |
| Row height, `sm` | 44px | `useTableVirtual.ts` `ROW_HEIGHT` |
| Row height, `md` (default) | 52px | same |
| Row height, `lg` (identity rows) | 64px | same |
| Row height, card surfaces | declared per surface (`rowHeight`) | `DataTable.tsx`; search uses `SEARCH_CARD_ROW_HEIGHT` (176px) |
| Windowing threshold | above 100 loaded rows | `VIRTUALIZATION_THRESHOLD` |
| Scroll viewport when windowed | `maxHeight` or 70vh | `DataTable.tsx` |
| Numeric alignment | `tabular-nums` on `align: 'end'` | `grid-roles.ts` `cellAlignmentClass` |
| Roles | `role="grid"` / `row` / `gridcell` / `columnheader` | `DataTable.tsx`, `GridRow.tsx` |
| Header row index | `aria-rowindex={1}` | `grid-roles.ts` `HEADER_ROW_INDEX` |
| Row count | `total + 1`, or `-1` when unknown | `grid-roles.ts` `ariaRowCount` |
| Empty states | `table-blank` and `table-filtered-empty` | `states/` |
| Renderers | `table`, `grouped`, `board`, `stacked` | `renderers/` |

`chrome="minimal"` hides the toolbar and visually hides the header row — for a grid whose row *is* a
card, where a column-visibility menu over one column reads as a mistake. The header row stays in the
accessibility tree, because `aria-rowcount` counts it.


## Tables — the `--tbl-*` visual contract (plan phase-3/14)

Phase 3 gave the app one table *shell*. This is the one table *look*: every table in the product —
the interactive `DataTable` grid and the native `SemanticTable` — draws from the `--tbl-*` block in
`globals.css` and from nothing else.

### Provenance

The reference was supplied on 2026-08-11 as two equivalent artifacts: `Design.pdf` (the visual
authority for composition and hierarchy) and `Sistema de tablas.html` (the authority for literal
values). The reference ships a SCSS token block; BuilderHunt mirrors it as CSS custom properties
rather than adding Sass to the toolchain for one file. Neither artifact is in the repository — the
extracted contract lives in
[`plans/implemented/phase-3/14-unified-table-visual-style/spec.md`](../plans/implemented/phase-3/14-unified-table-visual-style/spec.md),
and the token block itself is the executable copy.

### The four deliberate deviations from the supplied literals

The same specification that supplied these colours also requires WCAG AA. Four of its roles do not
clear it on the surface they sit on, and each moves one step down the reference's own stone ramp.
`tests/unit/shared/lib/accessibility.test.ts` pins all four in both themes, so a future edit putting
the original values back because they "look closer to the design" fails the suite.

| Role | Reference | Shipped | Why |
| --- | --- | --- | --- |
| Muted text | `#A8A29E` | `#57534E` | 2.52:1 on white; the next step (`#78716C`) still only reaches 4.48:1 on the selected-row tint |
| Idle header | `#A8A29E` | `#78716C` | 11px/700 is not "large text" (that starts at 18.66px bold), so it is held to 4.5:1 |
| Active header | `#78716C` | `#44403C` | moves with the idle one, preserving the relationship the reference is actually specifying |
| Focus ring | `#E8703A` | `#CA5D25` | 3.14:1 on white but 2.93:1 on a selected row — the row a keyboard user is most likely to be acting on |

`#A8A29E` survives verbatim as `--tbl-text-faint`, for the things it can carry: the ratio bar's
unfilled track and hairline rules. Never words.

Dark mode is a semantic remapping onto the existing BuilderHunt palette, not the same literals on a
different background — pasting a warm stone ramp tuned for a white page into `.dark` puts near-black
ink on a near-black surface. The chips become their own opaque dark tints, because a translucent
fill composites differently on a selected row and quietly loses contrast.

### Anatomy

| Element | Contract | Token |
| --- | --- | --- |
| Container | 14px radius, 1px border, subtle shadow, clipped | `--tbl-radius`, `.tbl-container` |
| Toolbar | 58px minimum (`min-height`, so eight facet chips may wrap rather than clip) | `--tbl-toolbar-height` |
| Header | 34px, sticky, 11px/700 uppercase at `.07em` | `--tbl-header-height`, `--tbl-font-header-*` |
| Rows | 44 / 52 / 64px by container `data-density` | `--tbl-row-height-{sm,md,lg}` |
| Footer | 44px, `X of Y` left, cursor actions right, never page numbers | `--tbl-footer-height`, `TableFooter.tsx` |
| Horizontal rhythm | 16px inline padding, 20px inter-column gap | `--tbl-padding-inline`, `--tbl-column-gap` |
| Fixed columns | status 116, category 132, date 168, number 88, ratio 120, actions 44 | `--tbl-col-*` |
| Flexible column | only `primary`, at `minmax(240px, 1.6fr)` | `--tbl-col-primary` |

Row height has **one** source of truth: `ROW_HEIGHT` in `useTableVirtual.ts`, because the virtualizer
computes every offset as `index * rowHeight`. `DataTable` writes it back onto the container as an
inline `--tbl-row-height`, so the painted height and the computed height cannot drift. The values in
`globals.css` are the fallback a table that sets no density (`SemanticTable`) resolves against.

### Two primitives, one contract

- **`DataTable`** — interactive, paged and virtualized collections. A `role="grid"` over a div tree,
  because virtualized rows inside a `<tbody>` need spacer rows and `translateY`, which fight sticky
  group headers and column alignment (plans 05–06).
- **`SemanticTable`** — bounded prose, comparisons and summaries. Real `table`/`thead`/`tbody`, with
  `scope="col"` on every header and `scope="row"` on the row's identity. That is what makes a screen
  reader announce "Pro Max, Monthly credits, 700" instead of a bare number, and it is the thing the
  ARIA grid would have to rebuild by hand.

A visible `<table>` element may only be written inside `SemanticTable.tsx`. `pnpm check:table-surfaces`
fails on any other, with two declared exceptions: a `.sr-only` chart equivalent (`BarSeries`) and
`lib/email.ts`, whose clients strip stylesheets and support none of this.

### The nine cell kinds

`primary`, `status`, `category`, `date`, `number`, `ratio`, `identity`, `empty`, `actions`. Eight have
a component in `src/shared/components/table/cells/`; `category` deliberately does not, because its
rule is "plain text, never a decorative grey chip" and a component whose whole body is `{value}` is
one somebody gives a background.

**Only free text may ellipsize**, and it hands over the complete string through `title`. A date, a
number or a status that truncates is a different value, not a shortened one — which is why those
kinds take fixed tracks instead of a share of the free width.

### Overflow belongs to the table

Fixed column widths mean a wide table wants more room than a laptop has. `.tbl-scroll` absorbs it;
the document never widens. Two assertions hold that: `tests/e2e/responsive-device-matrix.spec.ts`
checks the page against the viewport at five widths, and `tests/e2e/data-tables.spec.ts` checks that
the scroller is genuinely the box holding the extra width rather than the columns having collapsed.

Both `.tbl-container` and `.tbl-scroll` are `position: relative`, and that is load-bearing for a
non-obvious reason: `.sr-only` is `position: absolute`, and **neither `overflow: clip` nor
`overflow: auto` clips an absolutely-positioned descendant whose containing block sits outside them**.
Without a positioned ancestor, one invisible 1px span inside an empty cell in a horizontally-scrolled
table pushed the document 226px past the viewport, with nothing visibly wrong.

`.tbl-container` uses `overflow: clip` rather than `hidden` for a second non-obvious reason: `hidden`
creates a scroll container, and a scroll container is what a `position: sticky` descendant resolves
against — the floating selection dock inside would stop tracking the viewport.
