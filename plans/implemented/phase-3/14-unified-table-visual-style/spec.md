# Specification — adopt the canonical table visual system

> **Status**: `implemented`
> **Depends on**: [`13-pagination-ci-gates`](../../../implemented/phase-3/13-pagination-ci-gates/spec.md)
> **Blocks**: nothing
> **Reality check**: `src/shared/components/table/DataTable.tsx` already centralizes the interactive grid used by 20 JSX call sites, while `scripts/check-table-surfaces.mjs` classifies 23 table-bearing source files. The shell already owns sorting, keyboard navigation, selection, virtualization and four renderers; this plan changes its visual contract and closes the remaining raw-table styling gap instead of rebuilding table behavior.

## Source validation

The product reference was supplied in two equivalent artifacts on 2026-08-11:

- `Design.pdf`: two-page visual export.
- `Sistema de tablas.html`: extractable source for the same design.

The HTML was checked against both rendered PDF pages. The canonical example, anatomy, nine cell
types, row/table states, SCSS token block and ten agent rules match. There are no content conflicts.
The HTML is the authority for literal values; the PDF is the visual authority for composition and
hierarchy.

## Problem

BuilderHunt has one behavioral table shell but not one finished visual system. `DataTable` still
uses generic card, border, spacing and typography utilities; its current row heights are 34/40px,
its grid columns are mostly proportional, its selection bar is an inline strip, and the footer
pattern from the reference does not exist. Five visible raw `<table>` instances also style their
own headers, cells and borders.

The result is consistent behavior with inconsistent visual anatomy. A new surface can pass
`check:table-surfaces` while still inventing local density, colors or cell treatments.

## Goal

Make the supplied table system the single visual contract for every table rendered in the app,
without regressing the pagination, virtualization, accessibility, dark theme or responsive behavior
that phase 3 already shipped.

## Canonical contract

### Anatomy and geometry

| Element | Contract |
| --- | --- |
| Container | 14px radius, 1px border, subtle shadow, clipped outer surface |
| Toolbar | 58px; search left, counted filter chips, column control at the far right |
| Header | 34px; 11px/700 uppercase text, `.07em` tracking, active sort stronger than idle headers |
| Rows | `sm` 44px for large lists, `md` 52px default, `lg` 64px for identity/avatar rows |
| Footer | 44px; `X of Y` left, pagination right; hidden only at ten or fewer rows with no pagination |
| Horizontal rhythm | 16px inline padding, 20px inter-column gap |
| Fixed columns | status 116px, category 132px, date 168px, number 88px, ratio 120px, actions 44px |
| Flexible column | only the primary column, starting at `minmax(240px, 1.6fr)` |

Density is inherited from the table container through `data-density="sm|md|lg"`. Individual cells
may not choose their own height. Search's 176px result-card row remains a specialized renderer, but
its value becomes a named table token rather than a local literal.

### Light-theme tokens

The reference literals are preserved as `--tbl-*` CSS custom properties in
`src/shared/styles/globals.css`; BuilderHunt does not add Sass solely to mirror the source filename.

| Role | Value |
| --- | --- |
| Surface / subtle surface | `#FFFFFF` / `#FAFAF9` |
| Outer / header / row borders | `#E2DFDA` / `#EDEAE6` / `#F5F3F1` |
| Primary / secondary / muted text | `#1B1917` / `#44403C` / `#A8A29E` |
| Active header | `#78716C` |
| Accent | `#E8703A` |
| Selected / danger row | `#FDF6F1` / `#FEF9F8` |
| Success | `#EAF7EE` / `#166534` |
| Warning | `#FEF3E7` / `#9A5B0B` |
| Danger | `#FDECEA` / `#9F2D20` |
| Neutral | `#F5F4F2` / `#78716C` |

Dark mode receives semantic `--tbl-*` overrides mapped to the existing BuilderHunt dark palette.
The light literals must not be copied unchanged into `.dark`; contrast remains at least WCAG AA for
text and 3:1 for focus/interactive boundaries.

### Cell vocabulary

Every interactive grid column declares one of these kinds in `ColumnDef`: `primary`, `status`,
`category`, `date`, `number`, `ratio`, `identity`, `empty` or `actions`.

- Primary: 13.5px/600 title plus optional 11px mono metadata; the only two-line default cell.
- Status: semantic chip, 22px high, 6px radius, at most five states per table.
- Category: plain text, never a decorative gray chip.
- Date: relative value above abbreviated absolute value; never raw ISO and never truncated.
- Number: right aligned, tabular numerals and unit included.
- Ratio: progress bar plus numeric value.
- Identity: 26px avatar and name; email/metadata on a second line, not a separate column.
- Empty: muted em dash; columns more than 70% empty start hidden.
- Actions: one 44px sticky trailing column, at most one visible action plus overflow menu.

Only free text may ellipsize, and it exposes the complete value through an accessible title or
equivalent tooltip. Dates, status and numeric cells receive enough width and do not truncate.

### States and interaction

All data grids support the five reference states: normal, loading skeleton in the final grid,
genuine empty with an action, filtered empty with Clear filters, and load error with Retry.
Row variants are resting, hover, selected/active, danger/degraded and muted/paused. Selection uses a
floating bottom action bar rather than repeating several action buttons in every row.

Sorting is only exposed for text, dates and numbers with a meaningful natural order. Status and
actions never show sort affordances. Header and actions stay visible during their respective scroll
axes.

## Architecture decisions

### Keep the ARIA grid for interactive tables

The reference asks for native `table/thead/tbody`. BuilderHunt's interactive shell intentionally
uses `role="grid"` over a virtualized div tree; `DataTable.tsx` and `grid-roles.ts` already own the
row/column arithmetic and axe coverage. Replacing it with native table markup would reopen the
virtualization and sticky-group-header problem solved in plans 05–06.

This plan adopts the reference's accessibility outcome rather than its exact DOM prescription:
named grid, `row`/`columnheader`/`gridcell`, `aria-sort`, visible 2px accent focus, keyboard-reachable
row actions and verified row/column indices. Native markup remains mandatory for non-interactive
semantic tables.

### Two primitives, one token system

- `DataTable`: interactive, paged/virtualized collections and its table/grouped/stacked/board
  renderers.
- `SemanticTable`: bounded prose, comparisons and summaries that need native table semantics but
  no data-grid interaction.

Both consume the same `--tbl-*` tokens and cell presentation primitives. Local table colors,
spacing, density and status-chip variants are forbidden.

## Complete adoption scope

The existing gate reports 23 classified table-bearing files. Adoption covers:

- All 20 `<DataTable>` render call sites through the shared shell and renderer components.
- The five visible raw-table instances: cookies (1), pricing (2), conversion metrics (1) and
  profile hygiene (1), migrated to `SemanticTable` or the same semantic table classes.
- `BarSeries.tsx`'s screen-reader-only table: semantics and tests remain, with no visible styling
  requirement.
- `DataTable.tsx`'s internal accessible header structure: governed by the shell itself.

`src/shared/lib/email.ts` is HTML email output, not an app surface, and remains outside this visual
system because email clients require inline compatibility styles. It stays explicitly documented.

## Non-goals

- Changing server pagination, filtering, grouping or capability authorization.
- Removing virtualization or the four renderer choices.
- Making every table column sortable.
- Coloring categories for decoration.
- Redesigning cards, forms or charts that do not represent rows and columns.

## Success metrics

- `pnpm check:table-surfaces` still reports every table-bearing file and additionally rejects local
  visual literals or an ungoverned table primitive.
- All 20 `DataTable` call sites inherit the new contract without per-surface style overrides.
- All five visible raw tables render through `SemanticTable`/canonical classes.
- Unit tests cover tokens, density, column kinds, sticky actions, sort eligibility and all five
  states.
- `pnpm test:a11y`, `pnpm test:e2e tests/e2e/data-tables.spec.ts`, the responsive matrix and visual
  table baselines pass in light/dark and desktop/mobile configurations.
- A manual route walk confirms every classified visual table renders without page-level horizontal
  overflow, clipped dates/numbers/statuses or inaccessible actions.

