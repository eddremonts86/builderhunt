import type { ReactNode } from 'react'

/**
 * The nine presentations a cell may take.
 *
 * The reference's vocabulary, adopted verbatim. It exists because "a column renders whatever JSX
 * the surface felt like" is what produced nine different date formats and four different status
 * chips across nineteen tables — every one of them locally reasonable and collectively unreadable.
 *
 * The kind is not decoration. It decides three things at once: which presentation primitive in
 * `shared/components/table/cells` renders the value, how wide the column's grid track is, and
 * whether the cell is allowed to truncate. A `date` column is 168px and never ellipsizes because a
 * half-shown date is a wrong date; a `primary` column is the only flexible track and the only one
 * that may ellipsize, because free text is the only content whose tail is expendable.
 */
export type ColumnKind =
  | 'primary'
  | 'status'
  | 'category'
  | 'date'
  | 'number'
  | 'ratio'
  | 'identity'
  | 'empty'
  | 'actions'

/**
 * How one column renders and what it can do.
 *
 * The only file in `shared/lib/table` that knows React exists, so a repository can import the
 * query types without pulling a renderer into a worker process.
 *
 * `sortable` and `groupable` describe *intent*. They are not authorization: plan 03 resolves every
 * sort and filter id through a per-table server allowlist, because a column id arriving from a
 * client is a string, and a string that reaches an `ORDER BY` unchecked is an injection surface.
 * A column marked `sortable` with no matching entry in that allowlist yields a 400, not a query.
 */
export interface ColumnDef<Row> {
  id: string
  header: string
  cell: (row: Row) => ReactNode
  /**
   * The primitive behind the cell.
   *
   * Sorting and grouping need something comparable, and a cell rendering an avatar beside a name
   * is not. A column whose `cell` returns anything other than plain text needs this.
   */
  value?: (row: Row) => string | number | null
  /**
   * Which of the nine canonical presentations this column is.
   *
   * Optional on purpose, and it is the plan's stated compatibility default: an unclassified column
   * keeps the pre-adoption proportional sizing (`weight`) so the shell could be restyled before
   * every one of twenty surfaces had been walked through. `check-table-surfaces` is what stops that
   * default from becoming permanent.
   */
  kind?: ColumnKind
  align?: 'start' | 'end'
  /**
   * Share of the free width, relative to the other flexible columns. Defaults to 1.
   *
   * Only consulted for a column with no `kind` — a classified column takes its width from the
   * reference's fixed table instead, which is the whole point of classifying it. Kept because the
   * alerts inbox renders a whole person card in one cell beside two thin ones; at an equal share
   * the card was squeezed to about a third of the row and `PersonResultCard`'s truncated name
   * collapsed to nothing, so a match read as a bare avatar.
   */
  weight?: number
  sortable?: boolean
  groupable?: boolean
  /**
   * Which columns survive the stacked renderer below `md`.
   *
   * `primary` is the row's identity and always shows; `secondary` shows when there is room;
   * `detail` is revealed on expansion. Defaults to `secondary` when unset.
   */
  priority?: 'primary' | 'secondary' | 'detail'
}

/**
 * Which kinds may never be sorted, whatever a column author writes.
 *
 * The reference's rule: sorting is exposed for text, dates and numbers, and never for status or
 * actions. A status column sorts alphabetically by an internal enum spelling, which orders `active`
 * before `blocked` before `pending` and means nothing to anyone; an actions column has no value at
 * all. Both would still render a clickable header with an `aria-sort` a screen reader announces,
 * which is worse than not offering it.
 *
 * `ratio` is deliberately absent: it is a number with a real order, drawn as a bar.
 */
const UNSORTABLE_KINDS: ReadonlySet<ColumnKind> = new Set<ColumnKind>(['status', 'actions'])

/** Whether the header for this column should offer a sort control. */
export function isSortable<Row>(column: ColumnDef<Row>): boolean {
  if (!column.sortable) return false
  return column.kind === undefined || !UNSORTABLE_KINDS.has(column.kind)
}
