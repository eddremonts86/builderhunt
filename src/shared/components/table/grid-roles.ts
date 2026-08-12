import type { ColumnDef, ColumnKind } from '~/shared/lib/table/columns'

/**
 * The ARIA bookkeeping an `<table>` would have done for us, and the column geometry the reference
 * specifies.
 *
 * The shell is a div tree with `role="grid"` rather than a real table, and that choice is paid for
 * here. It is made for plan 06: virtualized rows inside a `<tbody>` need spacer rows and
 * `translateY`, which fight sticky group headers and column alignment. Building the layout twice
 * would be worse than owning the indices — but owning them means getting them right, so the
 * arithmetic lives in one tested module instead of inline in four renderers.
 */

/** Selection checkbox and expansion chevron are grid columns too; the header occupies row 1. */
export const HEADER_ROW_INDEX = 1

/**
 * `aria-rowindex` for a loaded row.
 *
 * `offset` is the absolute position of the first loaded row, so a table that replaces rows per page
 * instead of accumulating them still announces "row 148 of 3,204" rather than "row 8".
 */
export function ariaRowIndex(indexInPage: number, offset = 0): number {
  return HEADER_ROW_INDEX + offset + indexInPage + 1
}

/**
 * `aria-rowcount` for the whole filtered set.
 *
 * `+1` for the header row, which carries `aria-rowindex={1}` — the count and the indices have to
 * describe the same sequence or a screen reader announces "row 51 of 50".
 *
 * The number comes from `PageResult.total`, never from `rows.length`: the entire point is that a
 * screen-reader user learns the list is partial without scrolling to find out.
 *
 * `-1` is what ARIA reserves for "the total is not known" (`aria-rowcount`, WAI-ARIA 1.2), and it is
 * the honest answer for the federated search: nothing can count third-party results without
 * exhausting every upstream. Passing `rows.length` there instead would announce "row 50 of 50" at
 * the bottom of a list that has more, which is worse than announcing nothing.
 */
export function ariaRowCount(total: number | null): number {
  return total === null ? -1 : total + 1
}

/** `aria-colindex` is 1-based and counts every rendered column, control columns included. */
export function ariaColIndex(indexInRow: number): number {
  return indexInRow + 1
}

export interface GridTemplateOptions {
  /** A leading column for the selection checkbox. */
  selectable?: boolean
  /** A trailing column for the row's expansion control. */
  expandable?: boolean
}

/**
 * The reference's fixed widths, as the token names rather than the numbers.
 *
 * Numbers here would be a second source of truth beside `globals.css`. They are pixel values in the
 * reference — status 116, category 132, date 168, number 88, ratio 120, actions 44 — and they live
 * in `--tbl-col-*`, so a designer changing one changes it once.
 */
const FIXED_TRACK: Partial<Record<ColumnKind, string>> = {
  status: 'var(--tbl-col-status)',
  category: 'var(--tbl-col-category)',
  date: 'var(--tbl-col-date)',
  number: 'var(--tbl-col-number)',
  ratio: 'var(--tbl-col-ratio)',
  actions: 'var(--tbl-col-actions)',
  empty: 'var(--tbl-col-empty)',
}

/**
 * The minimum a fixed track occupies, in px, mirroring `FIXED_TRACK`.
 *
 * Needed because CSS cannot tell the container how wide its own content wants to be in a way JS can
 * read before layout, and the scroller needs a `min-width` up front — see `gridMinWidth`.
 */
const FIXED_WIDTH_PX: Partial<Record<ColumnKind, number>> = {
  status: 116,
  category: 132,
  date: 168,
  number: 88,
  ratio: 120,
  actions: 44,
  empty: 88,
}

/** The two flexible kinds, and the control columns the shell adds. */
const PRIMARY_MIN_PX = 240
const IDENTITY_MIN_PX = 180
const CONTROL_COLUMN_PX = 36
/** Unclassified columns keep the pre-adoption behaviour and claim no minimum. */
const UNCLASSIFIED_MIN_PX = 0

/**
 * `grid-template-columns` for one renderer.
 *
 * The reference's rule, and the reason this is not simply `1fr` everywhere: **only the primary
 * column is flexible.** A date that shares the free space with everything else is a date that
 * truncates on a narrow screen, and a truncated date is a wrong date. So status, category, date,
 * number, ratio and actions take fixed tracks and the primary column absorbs what is left, starting
 * at `minmax(240px, 1.6fr)`.
 *
 * That means a wide table can want more width than its container has. That is intended, and it is
 * why the grid lives inside `.tbl-scroll`: the overflow belongs to the table's own scroller, never
 * to the document. `tests/e2e/responsive-device-matrix.spec.ts` asserts the second half of that.
 *
 * A column with no `kind` falls back to `minmax(0, {weight}fr)` — the pre-adoption behaviour, kept
 * so the shell could be restyled ahead of classifying twenty surfaces' worth of columns.
 */
export function gridTemplateColumns<Row>(
  columns: ColumnDef<Row>[],
  options: GridTemplateOptions = {},
): string {
  const parts: string[] = []
  if (options.selectable) parts.push('var(--tbl-col-select)')
  for (const column of columns) {
    parts.push(columnTrack(column))
  }
  if (options.expandable) parts.push('var(--tbl-col-expand)')
  return parts.join(' ')
}

function columnTrack<Row>(column: ColumnDef<Row>): string {
  const fixed = column.kind ? FIXED_TRACK[column.kind] : undefined
  if (fixed) return fixed
  if (column.kind === 'primary') {
    return 'var(--tbl-col-primary)'
  }
  if (column.kind === 'identity') {
    return 'var(--tbl-col-identity)'
  }
  // Unclassified. `minmax(0, …)` rather than `1fr`: without the zero minimum a long cell pushes the
  // grid wider than its container, which is what makes a table scroll sideways on a laptop.
  return column.align === 'end'
    ? 'minmax(0, max-content)'
    : `minmax(0, ${column.weight ?? 1}fr)`
}

/**
 * The narrowest the grid may become, in px, before the scroller has to take over.
 *
 * Every row is its own CSS grid, so they only stay in column with each other if they are all at
 * least this wide. Applying it as a `min-width` on each row — rather than wrapping them in one
 * sized element — keeps the DOM a flat sequence of `role="row"` children, which is what
 * `aria-required-children` wants of a `role="grid"` and what the virtualizer's absolute positioning
 * assumes.
 *
 * Returns 0 when nothing in the table is fixed-width, so an all-unclassified table behaves exactly
 * as it did before adoption.
 */
export function gridMinWidth<Row>(
  columns: ColumnDef<Row>[],
  options: GridTemplateOptions = {},
): number {
  let total = 0
  let anyFixed = false
  const tracks = columns.length + (options.selectable ? 1 : 0) + (options.expandable ? 1 : 0)

  if (options.selectable) total += CONTROL_COLUMN_PX
  if (options.expandable) total += CONTROL_COLUMN_PX
  for (const column of columns) {
    const fixed = column.kind ? FIXED_WIDTH_PX[column.kind] : undefined
    if (fixed !== undefined) {
      total += fixed
      anyFixed = true
      continue
    }
    if (column.kind === 'primary') { total += PRIMARY_MIN_PX; anyFixed = true; continue }
    if (column.kind === 'identity') { total += IDENTITY_MIN_PX; anyFixed = true; continue }
    total += UNCLASSIFIED_MIN_PX
  }

  if (!anyFixed) return 0
  // 20px between every pair of adjacent tracks — the reference's inter-column gap — plus the 16px
  // inline padding on each side of the row.
  const COLUMN_GAP_PX = 20
  const PADDING_INLINE_PX = 16
  return total + Math.max(tracks - 1, 0) * COLUMN_GAP_PX + 2 * PADDING_INLINE_PX
}

/**
 * Which columns survive the stacked renderer below `md`.
 *
 * `primary` is the row's identity and always shows. `secondary` is the default, so a column author
 * who says nothing gets the middle behaviour rather than disappearing.
 */
export function columnsForPriority<Row>(
  columns: ColumnDef<Row>[],
  priorities: Array<NonNullable<ColumnDef<Row>['priority']>>,
): ColumnDef<Row>[] {
  return columns.filter((column) => priorities.includes(column.priority ?? 'secondary'))
}

/**
 * Numeric cells line up only with tabular figures; a monospace face is for code alone (DESIGN.md:221).
 *
 * `number` and `ratio` are right-aligned by their kind, so a column author does not have to
 * remember `align: 'end'` on every count in the app — and cannot forget it on one.
 */
export function cellAlignmentClass<Row>(column: ColumnDef<Row>): string {
  return isEndAligned(column) ? 'text-right tabular-nums justify-end' : 'text-left'
}

/** Whether this column's content sits against the trailing edge of its track. */
export function isEndAligned<Row>(column: ColumnDef<Row>): boolean {
  if (column.align === 'end') return true
  return column.kind === 'number' || column.kind === 'ratio' || column.kind === 'actions'
}
