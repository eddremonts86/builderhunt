# Specification — row virtualization

> **Status**: `pending`
> **Depends on**: [`05-table-shell`](../05-table-shell/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: `src/modules/search/components/SearchPage.tsx` already appends pages into a growing array (`setResults((prev) => [...prev, ...newOnes.filter(…)])`, `SearchPage.tsx:418`) with no virtualization, so a long session accumulates unbounded DOM. The shell from plan 05 renders every loaded row.

## Problem

Pagination bounds what the *database* returns per request, not what the *browser* holds. Infinite
scroll appends, so a person scrolling a large result set for a minute accumulates thousands of
rows; every subsequent render, hover and re-sort then pays for all of them. Bounding the query
without virtualizing the list solves half the problem and hides the other half.

## Goal

DOM cost that stays flat as the loaded set grows, with keyboard navigation and ARIA indices still
correct — which is the part that does not come for free.

## Non-goals

- **Variable row heights.** Row height is fixed per density, so `estimateSize` is exact and no
  measurement pass is needed. Variable heights would be a separate plan.
- **Virtualizing columns.** Row virtualization only; the widest table has a handful of columns.
- **Changing the fetch loop.** The shell already requests the next page; this plan changes what is
  rendered, not what is fetched.

## The two hazards

These are the substance of this plan. Both are silent failures, which is why virtualization is its
own plan rather than a line in plan 05.

**Virtualization breaks a roving tabindex.** The focused cell is unmounted when it scrolls out of
the render window, and browser focus falls back to `<body>`. Keyboard navigation then dies mid-list
with no error and no visual cue — in exactly the long lists virtualization exists for.

The fix is a **focus pin**: the focused row index is forced into the virtualizer's render range
alongside overscan, and DOM focus is re-applied to the matching cell after any remount. This is
asserted directly rather than assumed: focus a cell, `PageDown` past the window, `PageUp` back, and
the same cell must still hold focus.

**ARIA indices must describe the full set, not the window.** A virtualized row's `aria-rowindex`
has to be its absolute position, and `aria-rowcount` the server's `total`. Get this wrong and a
screen reader announces "row 3 of 50" inside a 5,000-row list. axe does not catch it, because the
markup is structurally valid — only an explicit assertion does.

## Density

Row height comes from the existing dashboard density preference
(`src/modules/dashboard/ui/bento/useBentoDensity.ts`, stored at `bh.dashboard.density`):
`comfortable` 40px, `compact` 34px. That hook reads localStorage in an effect rather than during
render, and its comment explains why — reading during render costs a hydration mismatch. The same
constraint applies here.

## Success metrics

- With 500+ rows loaded, the rendered row count stays within the virtualizer window while
  `aria-rowcount` reports the full total.
- Focus survives a `PageDown`/`PageUp` round trip past the render window.
- `aria-rowindex` on the last rendered row equals its absolute index, not its position in the
  window.
- Changing density changes row height and persists across a reload with no hydration warning.
- `pnpm test:a11y` still green.

## Resolved edge cases

- **Group headers inside a virtualized list.** Group rows are items in the virtual list, not
  separate DOM outside it, so their sticky offsets stay correct while scrolling.
- **The board renderer.** Scrolls horizontally with independently short columns; virtualization is
  applied per column or skipped, and skipping is recorded rather than left implicit.
- **Selection of rows that are not rendered.** Selection is keyed by row id, never by DOM
  presence, so scrolling never changes what is selected.
- **Scroll restoration after a sort change.** The window resets to the top, because the row that
  was at the caret may not be on page one of the new order.
