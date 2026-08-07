import type { ReactNode } from 'react'

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
  align?: 'start' | 'end'
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
