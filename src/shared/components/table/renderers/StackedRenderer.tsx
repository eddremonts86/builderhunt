import { Checkbox } from '~/components/ui/checkbox'
import { cn } from '~/shared/lib/utils'

import { ariaColIndex, ariaRowIndex, columnsForPriority, isEndAligned } from '../grid-roles'
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
  const { rows, columns, rowId, rowTestId, rowOffset, selectable, selection, keyboard, onPrimaryAction, rowTone } = context

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
            data-state={selected ? 'selected' : undefined}
            data-tone={rowTone?.(row)}
            // The same row tokens as the grid renderer, laid out as a card. The reference's point
            // about density and colour is that they do not change with the viewport — only the
            // arrangement does.
            className="tbl-row tbl-stacked-row"
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
                  className="tbl-cell tbl-cell-primary"
                >
                  {column.cell(row)}
                </div>
              ))}
              {/*
                * Divs, not a `<dl>`. A `role="row"` may only contain `gridcell`, `columnheader` or
                * `rowheader`, and a definition list puts `dl`, `dt` and `dd` inside it — axe reports
                * both `aria-required-children` (critical) and `definition-list` against the same
                * markup, and a screen reader navigating the grid finds children it cannot place.
                *
                * The label moves *inside* the cell instead of standing beside it as a `<dt>`, which
                * is also what makes the cell announce as "Last run, 3d ago" rather than as a bare
                * value whose column header is off-screen at this width.
                */}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {rest.map((column, columnIndex) => (
                  <div
                    key={column.id}
                    role="gridcell"
                    aria-colindex={ariaColIndex(identity.length + columnIndex + (selectable ? 1 : 0))}
                    className="flex min-w-0 items-baseline gap-1.5"
                  >
                    <span className="tbl-cell-meta">{column.header}</span>
                    <span className={cn('tbl-stacked-value', isEndAligned(column) && 'tabular-nums')}>
                      {column.cell(row)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
