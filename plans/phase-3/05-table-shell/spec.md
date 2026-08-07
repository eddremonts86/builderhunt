# Specification — the table shell

> **Status**: `implemented`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`06-row-virtualization`](../06-row-virtualization/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: The original audit found 19 tabular surfaces with five header treatments;
> plan 01's fresh inventory is authoritative for implementation and plan 13 requires every current
> surface to be classified. Design tokens, control heights, radii and both typefaces are fixed by
> `DESIGN.md` and `docs/visual-system.md`. `src/components/ui/` already provides `Button`, `Input`,
> `Select`, `Checkbox`, `Dialog` (Radix). `tests/regression/test-status-and-trust.mjs` drives
> existing rows by `data-testid`.

## Problem

Every list was built independently, so a person has to relearn each one. There is no shared
keyboard model, no shared selection model, no shared empty state, and no agreement on how a
numeric column aligns.

## Goal

One component that takes a `ColumnDef[]` and a `PageResult`, and provides everything else:
header, sorting affordance, filter toolbar, grouping, selection, keyboard navigation, four states,
and the four renderers.

## Non-goals

- **Data fetching.** The shell renders a `PageResult` it is handed.
- **Virtualization.** Plan 06, deliberately separate because it is the subtle part.
- **Editable cells.** A per-table `expansion` slot exists for things like `admin/users.tsx`'s
  inline edit row; the shell knows nothing about the form inside it.
- **Column resizing or drag-reorder.** Column *visibility* is in scope; sizing is not.

## Structure

ARIA grid over a div tree, not `<table>`. `role="grid"` with `row`, `columnheader`, `gridcell`,
plus `aria-rowindex`, `aria-colindex`, `aria-rowcount` when `PageResult.total` is known (never a
fabricated loaded count) and `aria-colcount`. Provider-backed lists with `total: null` omit
`aria-rowcount` and announce the loaded count plus "more results available". CSS grid template
columns does the alignment a `<table>` would have done.

The reason is plan 06: virtualized rows inside a `<tbody>` need spacer rows and `translateY`, which
fights sticky group headers and column alignment. Choosing the div tree now avoids building the
layout twice. The cost is real — we take on the obligation to get the ARIA indices right — and
`pnpm test:a11y` (axe) plus explicit index assertions are what make it safe.

`@tanstack/react-table` runs in **manual mode** (`manualSorting`, `manualFiltering`,
`manualGrouping`, `manualPagination`). It contributes the column model, row model, selection state
and grouping state, and performs no sorting or filtering because the server already did.

## Keyboard model

| Key | Action |
|---|---|
| `↑` `↓` | move by row |
| `←` `→` | move by cell |
| `Home` / `End` | first / last cell in the row |
| `PageUp` / `PageDown` | ±10 rows |
| `Space` | toggle row selection |
| `⇧` + `↑` `↓` | extend the selection range |
| `Enter` | the row's primary action |
| `Esc` | clear selection |
| `/` | focus the toolbar filter |
| `⌘K` | command sheet — filter, sort and group verbs, each with its facet count |

Cell-level traversal is the default because the widest surfaces are admin queues where a row does
not fit on screen. A table can opt into row-only with `navigation="row"`.

## Selection with partial data

At 50 rows a page, the header checkbox can only mean "the loaded rows", so the shell renders two
distinct actions:

- **Select loaded** — the tri-state header checkbox, reporting "50 selected".
- **Select all N matching** — sends the `TableQuery` predicate to the server, which returns
  `{ count, token }`. Bulk actions take the token instead of an id list. A table that does not
  implement it **hides the action** rather than offering something that would silently mean
  something narrower.

## The four states

- **Loading** — skeleton rows matching real column widths, not a spinner.
- **Empty** — composed, explaining how data arrives.
- **Filtered-empty** — a *different* state, naming the filters and offering to clear them. Most
  tables get this wrong by showing one message for both, which reads as "there is no data" when
  the truth is "your filter excluded it".
- **Error** — an inline row that keeps already-loaded rows visible and offers retry.

## Visual contract

Fixed by the existing system, not re-decided here: `.card` frame at 24px radius, control heights
32/36/44, hairline `--color-bh-border` dividers, no per-row cards, one accent. Numeric columns use
`font-variant-numeric: tabular-nums` — **not** `font-mono`, which `DESIGN.md:221` restricts to
literal code and keys.

Below `md` the default renderer is `stacked`. `.table-scroll` (`src/shared/styles/globals.css:864`)
remains for the genuinely wide admin queues, as `docs/design/responsive-qa-checklist.md:51`
already decided.

## Migration constraint

`rowTestId: (row) => string` is a **required** prop, forwarded to each row as `data-testid`.
`tests/regression/test-status-and-trust.mjs` and several e2e specs drive rows by id; a shell that
generates its own ids would break a green suite for reasons unrelated to tables.

## Success metrics

- One `DataTable` renders a fixture through all four renderers with no per-renderer logic
  duplicated.
- axe reports no violations on the ARIA grid (`pnpm test:a11y`).
- Every key in the table above works, asserted in plan 07's shared e2e spec.
- `aria-rowcount` equals a known `PageResult.total`; it is absent when `total` is null.
- All four states reachable in a fixture story or e2e assertion.
