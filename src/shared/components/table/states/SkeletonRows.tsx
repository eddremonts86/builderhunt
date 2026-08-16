import type { ColumnDef } from '~/shared/lib/table/columns'
import { cn } from '~/shared/lib/utils'

import { ariaColIndex, gridMinWidth, gridTemplateColumns } from '../grid-roles'

interface SkeletonRowsProps<Row> {
  columns: ColumnDef<Row>[]
  count?: number
  selectable?: boolean
}

/**
 * Skeleton rows in the real column widths, not a spinner.
 *
 * A spinner replaces the table with a different shape, so the content jumps into place when it
 * arrives and the eye has to re-find the column it was reading. Rows that already occupy the final
 * grid do not move.
 *
 * They are `aria-hidden`: a screen reader announcing eight rows of nothing is worse than silence.
 * The grid's `aria-busy` is what carries the state.
 */
export function SkeletonRows<Row>({ columns, count = 8, selectable }: SkeletonRowsProps<Row>) {
  // The same floor every real row carries, so the skeleton occupies the final geometry rather than
  // a narrower one the rows then jump out of.
  const minWidth = gridMinWidth(columns, { selectable })

  return (
    <div aria-hidden="true" data-testid="table-skeleton">
      {Array.from({ length: count }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="tbl-row grid items-center"
          style={{
            gridTemplateColumns: gridTemplateColumns(columns, { selectable }),
            columnGap: 'var(--tbl-column-gap)',
            minWidth: minWidth > 0 ? minWidth : undefined,
          }}
        >
          {selectable && <div className="tbl-skeleton h-4 w-4" />}
          {columns.map((column, columnIndex) => (
            <div
              key={column.id}
              className={cn('tbl-skeleton h-4', columnIndex % 3 === 0 ? 'w-3/4' : 'w-1/2')}
              style={{ animationDelay: `${(rowIndex * columns.length + ariaColIndex(columnIndex)) * 30}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
