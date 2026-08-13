import * as React from 'react'

import { Checkbox } from '~/components/ui/checkbox'
import { cn } from '~/shared/lib/utils'

import { ariaColIndex, ariaRowIndex, cellAlignmentClass, gridMinWidth, gridTemplateColumns } from './grid-roles'
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
  const { columns, rowId, rowTestId, rowOffset, selectable, selection, keyboard, onPrimaryAction, rowTone, expansion, expandedRowId, onExpandedChange } = context
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

  const gridOptions = { selectable, expandable: Boolean(expansion) }
  const minWidth = gridMinWidth(columns, gridOptions)
  // Presentation only. A `danger` or `muted` row is still selectable, still keyboard-reachable and
  // still announced normally — dimming a row is not a way to disable it, and `aria-disabled` here
  // would be a lie the visual state cannot back up.
  const tone = rowTone?.(row)

  return (
    <>
      <div
        role="row"
        aria-rowindex={ariaRowIndex(index, rowOffset)}
        aria-selected={selectable ? selected : undefined}
        data-testid={rowTestId(row)}
        data-state={selected ? 'selected' : undefined}
        data-tone={tone}
        className="tbl-row grid items-center"
        style={{
          gridTemplateColumns: gridTemplateColumns(columns, gridOptions),
          columnGap: 'var(--tbl-column-gap)',
          minWidth: minWidth > 0 ? minWidth : undefined,
        }}
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
                'tbl-cell',
                cellAlignmentClass(column),
                // The one sticky column: actions stay reachable while the fixed-width middle
                // columns scroll horizontally underneath them.
                column.kind === 'actions' && 'tbl-actions-cell',
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
              className="tbl-expand-button"
            >
              <span aria-hidden="true">{expanded ? '−' : '+'}</span>
            </button>
          </div>
        )}
      </div>

      {expansion && expanded && (
        // The expansion is a row of the grid too — omitting the role would make a screen reader
        // announce a row count that does not match what it can navigate.
        <div role="row" className="tbl-expansion-row">
          <div role="gridcell" aria-colindex={1}>{expansion(row)}</div>
        </div>
      )}
    </>
  )
}
