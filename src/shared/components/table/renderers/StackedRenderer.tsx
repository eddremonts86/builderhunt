import { Checkbox } from '~/components/ui/checkbox'
import { cn } from '~/shared/lib/utils'

import { ariaColIndex, ariaRowIndex, columnsForPriority } from '../grid-roles'
import type { RendererContext } from './types'

/**
 * One row per card, below `md`.
 *
 * A nine-column admin queue on a 375px screen is either a horizontal scroll nobody discovers or a
 * font size nobody can read. The stacked renderer picks the columns worth keeping using
 * `ColumnDef.priority`: `primary` is the row's identity and leads, `secondary` follows as
 * label/value pairs, `detail` is dropped here and stays reachable through the row's own page.
 *
 * It is still a `role="row"` inside the same grid, with the same `aria-rowindex`, because the
 * accessibility tree should not change shape with the viewport.
 */
export function StackedRenderer<Row>({ context }: { context: RendererContext<Row> }) {
  const { rows, columns, rowId, rowTestId, rowOffset, selectable, selection, keyboard, onPrimaryAction } = context

  const primary = columnsForPriority(columns, ['primary'])
  const secondary = columnsForPriority(columns, ['secondary'])
  // A table whose author set no priorities would render an empty card, so fall back to the first
  // column as the identity rather than showing nothing.
  const identity = primary.length > 0 ? primary : columns.slice(0, 1)
  const rest = primary.length > 0 ? secondary : columns.slice(1)

  return (
    <>
      {rows.map((row, index) => {
        const id = rowId(row)
        const selected = selection.isSelected(id)
        return (
          <div
            key={id}
            role="row"
            aria-rowindex={ariaRowIndex(index, rowOffset)}
            aria-selected={selectable ? selected : undefined}
            data-testid={rowTestId(row)}
            className={cn(
              'flex gap-3 border-b border-bh-border px-4 py-3 last:border-b-0',
              selected && 'bg-bh-accent-soft',
            )}
            onDoubleClick={onPrimaryAction ? () => onPrimaryAction(row) : undefined}
          >
            {selectable && (
              <div role="gridcell" aria-colindex={ariaColIndex(0)} className="pt-0.5">
                <Checkbox
                  checked={selected}
                  onCheckedChange={() => selection.toggle(id)}
                  aria-label={`Select row ${ariaRowIndex(index, rowOffset)}`}
                  data-testid={`${rowTestId(row)}-select`}
                />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {identity.map((column, columnIndex) => (
                <div
                  key={column.id}
                  role="gridcell"
                  aria-colindex={ariaColIndex(columnIndex + (selectable ? 1 : 0))}
                  tabIndex={keyboard.isFocused(index, columnIndex) ? 0 : -1}
                  ref={(element) => keyboard.registerCell(index, columnIndex, element)}
                  onFocus={() => keyboard.setPosition({ row: index, column: columnIndex })}
                  className="truncate text-sm font-medium text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                >
                  {column.cell(row)}
                </div>
              ))}
              <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {rest.map((column, columnIndex) => (
                  <div key={column.id} className="flex min-w-0 items-baseline gap-1.5">
                    <dt className="text-xs text-bh-text-muted">{column.header}</dt>
                    <dd
                      role="gridcell"
                      aria-colindex={ariaColIndex(identity.length + columnIndex + (selectable ? 1 : 0))}
                      className={cn('truncate text-xs text-bh-text', column.align === 'end' && 'tabular-nums')}
                    >
                      {column.cell(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )
      })}
    </>
  )
}
