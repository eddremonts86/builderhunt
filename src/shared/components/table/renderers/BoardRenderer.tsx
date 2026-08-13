import { Checkbox } from '~/components/ui/checkbox'
import { cn } from '~/shared/lib/utils'

import { ariaColIndex, ariaRowIndex, columnsForPriority, isEndAligned } from '../grid-roles'
import type { RendererContext } from './types'

/**
 * Columns of cards, one column per value of the grouped dimension.
 *
 * For triage surfaces where the question is "what is in each state" rather than "what is in this
 * list". It groups only what is loaded, and each column's header carries the server's total beside
 * the loaded count for the same reason `GroupRow` does — a board that says "review (7)" when the
 * state holds 340 is a board that gets acted on wrongly.
 *
 * The board needs a grouped dimension. Without one it renders a single column, rather than
 * inventing a grouping the server did not order by.
 */
export function BoardRenderer<Row>({ context }: { context: RendererContext<Row> }) {
  const { rows, columns, query, page, rowId, rowTestId, rowOffset, selectable, selection, onPrimaryAction, rowTone } = context
  const groupColumn = columns.find((column) => column.id === query.groupBy)

  const read = (row: Row): string => {
    if (!groupColumn) return 'All'
    const value = groupColumn.value?.(row)
    return value === null || value === undefined ? '—' : String(value)
  }

  const lanes = new Map<string, Array<{ row: Row; index: number }>>()
  rows.forEach((row, index) => {
    const value = read(row)
    const lane = lanes.get(value) ?? []
    lane.push({ row, index })
    lanes.set(value, lane)
  })

  const serverTotals = new Map(
    (groupColumn ? page.facets[groupColumn.id] ?? [] : []).map((facet) => [facet.value, facet.count]),
  )

  const identity = columnsForPriority(columns, ['primary'])
  const summary = columnsForPriority(columns, ['secondary'])
  const cardIdentity = identity.length > 0 ? identity : columns.slice(0, 1)
  const cardSummary = identity.length > 0 ? summary : columns.slice(1, 4)

  return (
    <div className="tbl-board" data-testid="table-board">
      {[...lanes.entries()].map(([value, lane]) => (
        <section key={value} className="w-64 shrink-0" aria-label={value}>
          <header className="mb-2 flex items-baseline gap-2">
            <h3 className="tbl-group-label">{value}</h3>
            {serverTotals.has(value) && (
              <span className="tbl-group-count">{serverTotals.get(value)?.toLocaleString()} total</span>
            )}
            <span className="tbl-group-count">{lane.length.toLocaleString()} loaded</span>
          </header>
          <div className="flex flex-col gap-2">
            {lane.map(({ row, index }) => {
              const id = rowId(row)
              const selected = selection.isSelected(id)
              return (
                <article
                  key={id}
                  role="row"
                  aria-rowindex={ariaRowIndex(index, rowOffset)}
                  aria-selected={selectable ? selected : undefined}
                  data-testid={rowTestId(row)}
                  onDoubleClick={onPrimaryAction ? () => onPrimaryAction(row) : undefined}
                  data-state={selected ? 'selected' : undefined}
                  data-tone={rowTone?.(row)}
                  className="tbl-row tbl-board-card"
                >
                  <div className="flex items-start gap-2">
                    {selectable && (
                      <div role="gridcell" aria-colindex={ariaColIndex(0)}>
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => selection.toggle(id)}
                          aria-label={`Select row ${ariaRowIndex(index, rowOffset)}`}
                          data-testid={`${rowTestId(row)}-select`}
                        />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      {cardIdentity.map((column, columnIndex) => (
                        <div
                          key={column.id}
                          role="gridcell"
                          aria-colindex={ariaColIndex(columnIndex + (selectable ? 1 : 0))}
                          className="tbl-cell-primary"
                        >
                          {column.cell(row)}
                        </div>
                      ))}
                      {cardSummary.map((column, columnIndex) => (
                        <div
                          key={column.id}
                          role="gridcell"
                          aria-colindex={ariaColIndex(cardIdentity.length + columnIndex + (selectable ? 1 : 0))}
                          className={cn('tbl-cell-meta', isEndAligned(column) && 'tabular-nums')}
                        >
                          {column.cell(row)}
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
