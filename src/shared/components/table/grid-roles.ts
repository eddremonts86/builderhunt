import type { ColumnDef } from '~/shared/lib/table/columns'

/**
 * The ARIA bookkeeping an `<table>` would have done for us.
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
 * `grid-template-columns` for one renderer.
 *
 * Data columns are `minmax(0, 1fr)` so a long cell truncates instead of pushing the grid wider than
 * its container — the failure that makes a table scroll horizontally on a laptop. Control columns
 * are fixed, because a checkbox does not want a share of the remaining space.
 */
export function gridTemplateColumns<Row>(
  columns: ColumnDef<Row>[],
  options: GridTemplateOptions = {},
): string {
  const parts: string[] = []
  if (options.selectable) parts.push('2.25rem')
  for (const column of columns) {
    parts.push(column.align === 'end'
      ? 'minmax(0, max-content)'
      : `minmax(0, ${column.weight ?? 1}fr)`)
  }
  if (options.expandable) parts.push('2.25rem')
  return parts.join(' ')
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

/** Numeric cells line up only with tabular figures; a monospace face is for code alone (DESIGN.md:221). */
export function cellAlignmentClass<Row>(column: ColumnDef<Row>): string {
  return column.align === 'end' ? 'text-right tabular-nums justify-end' : 'text-left'
}
