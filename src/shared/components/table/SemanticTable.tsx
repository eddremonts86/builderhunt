// table-surface-ok: the semantic primitive itself. Its <table> is the one visible table element in
// the app that is written by hand; every other one renders through this file, which is the rule
// check-table-surfaces enforces.
import type { ReactNode } from 'react'

import { cn } from '~/shared/lib/utils'

export interface SemanticColumn<Row> {
  id: string
  header: ReactNode
  cell: (row: Row) => ReactNode
  /** `end` right-aligns and switches on tabular figures; `center` is for tick/cross matrices. */
  align?: 'start' | 'center' | 'end'
  /**
   * Render this column's cell as `<th scope="row">` instead of `<td>`.
   *
   * At most one per table, and worth setting whenever the table has one: it is what lets a screen
   * reader announce "Pro Max, Monthly credits, 700" rather than reading "700" with no idea which
   * row or column it came from. A comparison table without it is a grid of numbers.
   */
  rowHeader?: boolean
}

interface SemanticTableProps<Row> {
  /**
   * Required. An unnamed table is a table a screen reader's element list cannot tell from the four
   * others on the page.
   */
  caption: string
  /** Show the caption above the table. Off by default — most of these sit under their own heading. */
  captionVisible?: boolean
  columns: SemanticColumn<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  rowTestId?: (row: Row) => string
  /**
   * A `data-testid` on the `<table>` itself.
   *
   * The scroll region always carries `semantic-table`, which is how the visual and inventory
   * specs find every instance. This is for the handful of surfaces whose own specs already drove
   * the element by a name of their own before the primitive existed.
   */
  tableTestId?: string
  className?: string
}

/**
 * The other half of the table system: real `table`/`thead`/`tbody` markup, same `--tbl-*` tokens.
 *
 * ## Why there are two primitives and not one
 *
 * The reference asks for native table markup throughout, and for interactive grids BuilderHunt
 * deliberately does not do that — `DataTable` is a `role="grid"` over a virtualized div tree,
 * because virtualized rows inside a `<tbody>` need spacer rows and `translateY`, which fight sticky
 * group headers and column alignment (plans 05–06 solved that once already).
 *
 * But everything that argument buys applies only to grids. Pricing's feature comparison is nine
 * rows that never change; the cookie policy is four. There, the ARIA grid would be a keyboard model,
 * a roving tabindex and a virtualizer over content a person reads rather than operates — and it
 * would *lose* something real, because native `<th scope>` gives a screen reader row-and-column
 * context that a div tree has to reconstruct by hand.
 *
 * So: `DataTable` for collections you operate, `SemanticTable` for tables you read. One token
 * contract underneath both, which is the part the plan is actually about.
 *
 * ## The scroll region
 *
 * A comparison table with five columns does not fit a phone, so it scrolls inside its own box —
 * never widening the document, which `tests/e2e/responsive-device-matrix.spec.ts` asserts. The
 * wrapper is `tabIndex={0}` with `role="region"` because a scrollable region that can only be
 * reached with a mouse is unreachable to a keyboard user (WCAG 2.1.1, the technique the pricing and
 * cookies pages already used before this primitive existed).
 */
export function SemanticTable<Row>({
  caption,
  captionVisible = false,
  columns,
  rows,
  rowKey,
  rowTestId,
  tableTestId,
  className,
}: SemanticTableProps<Row>) {
  return (
    <div
      className={cn('tbl-container tbl-scroll', className)}
      tabIndex={0}
      role="region"
      aria-label={caption}
      data-testid="semantic-table"
    >
      <table className="tbl-semantic" data-testid={tableTestId}>
        <caption className={captionVisible ? undefined : 'sr-only'}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              // `scope="col"` is the whole reason to use native markup here — it is what ties every
              // cell below to this label without the DOM having to encode it a second time.
              <th key={column.id} scope="col" data-align={column.align}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} data-testid={rowTestId?.(row)}>
              {columns.map((column) => (
                column.rowHeader
                  ? <th key={column.id} scope="row" data-align={column.align}>{column.cell(row)}</th>
                  : <td key={column.id} data-align={column.align}>{column.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
