import * as React from 'react'

import { Checkbox } from '~/components/ui/checkbox'
import { cn } from '~/shared/lib/utils'

import { ariaColIndex, ariaRowIndex, cellAlignmentClass, gridTemplateColumns } from './grid-roles'
import type { RendererContext } from './renderers/types'

interface GridRowProps<Row> {
  context: RendererContext<Row>
  row: Row
  /** Index within the loaded rows — the keyboard model's row coordinate. */
  index: number
}

/**
 * One `role="row"`, shared by every renderer that shows rows in a grid.
 *
 * It exists so the ARIA indices, the roving tabindex and the selection affordance are written once.
 * Three renderers rendering their own rows would be three chances for `aria-rowindex` to drift from
 * `aria-rowcount`, and that drift is invisible to everyone who is not using a screen reader.
 */
export function GridRow<Row>({ context, row, index }: GridRowProps<Row>) {
  const { columns, rowId, rowTestId, rowOffset, selectable, selection, keyboard, onPrimaryAction, expansion, expandedRowId, onExpandedChange } = context
  const id = rowId(row)
  const selected = selection.isSelected(id)

  /**
   * Expansion is the shell's state unless the surface claims it.
   *
   * Incidents needs the second form: opening a row *is* "edit this incident", and the surface has
   * to load that incident into its form when it opens. With the shell owning the flag, the surface
   * would have had to mirror it — and a component that mirrors another component's state is how the
   * old markup ended up keeping a row and a form in sync by hand.
   */
  const controlled = onExpandedChange !== undefined
  const [uncontrolledExpanded, setUncontrolledExpanded] = React.useState(false)
  const expanded = controlled ? expandedRowId === id : uncontrolledExpanded
  const setExpanded = (next: boolean) => {
    if (controlled) onExpandedChange(next ? id : null)
    else setUncontrolledExpanded(next)
  }

  // The selection checkbox is a grid column, so it shifts every data column's `aria-colindex` by
  // one. Computing it here rather than in each renderer is what keeps the two in step.
  const columnOffset = selectable ? 1 : 0

  return (
    <>
      <div
        role="row"
        aria-rowindex={ariaRowIndex(index, rowOffset)}
        aria-selected={selectable ? selected : undefined}
        data-testid={rowTestId(row)}
        data-state={selected ? 'selected' : undefined}
        className={cn(
          'grid items-center gap-3 border-b border-bh-border px-4 py-2.5 last:border-b-0',
          'hover:bg-bh-surface-2',
          selected && 'bg-bh-accent-soft',
        )}
        style={{ gridTemplateColumns: gridTemplateColumns(columns, { selectable, expandable: Boolean(expansion) }) }}
        onDoubleClick={onPrimaryAction ? () => onPrimaryAction(row) : undefined}
      >
        {selectable && (
          <div
            role="gridcell"
            aria-colindex={ariaColIndex(0)}
            className="flex items-center"
          >
            <Checkbox
              checked={selected}
              onCheckedChange={() => selection.toggle(id)}
              onClick={(event) => {
                // Shift-click extends from the keyboard model's current row, so mouse and keyboard
                // ranges are the same range rather than two competing anchors.
                if (event.shiftKey) selection.extend(keyboard.position.row, index)
              }}
              aria-label={`Select row ${ariaRowIndex(index, rowOffset)}`}
              data-testid={`${rowTestId(row)}-select`}
            />
          </div>
        )}

        {columns.map((column, columnIndex) => {
          const coordinate = columnIndex + columnOffset
          const focused = keyboard.isFocused(index, columnIndex)
          return (
            <div
              key={column.id}
              role="gridcell"
              aria-colindex={ariaColIndex(coordinate)}
              // Roving tabindex: exactly one cell in the whole grid is reachable by Tab, and the
              // arrows move which one. 50 rows × 8 columns behind Tab would be 400 presses deep.
              tabIndex={focused ? 0 : -1}
              ref={(element) => keyboard.registerCell(index, columnIndex, element)}
              onFocus={() => keyboard.setPosition({ row: index, column: columnIndex })}
              className={cn(
                'flex min-w-0 items-center truncate text-sm text-bh-text',
                cellAlignmentClass(column),
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bh-accent',
              )}
            >
              {column.cell(row)}
            </div>
          )
        })}

        {expansion && (
          <div role="gridcell" aria-colindex={ariaColIndex(columns.length + columnOffset)} className="flex items-center">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse row' : 'Expand row'}
              data-testid={`${rowTestId(row)}-expand`}
              className="rounded-md p-1 text-bh-text-muted hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
            >
              <span aria-hidden="true">{expanded ? '−' : '+'}</span>
            </button>
          </div>
        )}
      </div>

      {expansion && expanded && (
        // The expansion is a row of the grid too — omitting the role would make a screen reader
        // announce a row count that does not match what it can navigate.
        <div role="row" className="border-b border-bh-border bg-bh-surface-2 px-4 py-3">
          <div role="gridcell" aria-colindex={1}>{expansion(row)}</div>
        </div>
      )}
    </>
  )
}
