import { describe, expect, it } from 'vitest'

import {
  ariaColIndex,
  ariaRowCount,
  ariaRowIndex,
  cellAlignmentClass,
  columnsForPriority,
  gridTemplateColumns,
  HEADER_ROW_INDEX,
} from '~/shared/components/table/grid-roles'
import type { ColumnDef } from '~/shared/lib/table/columns'

/**
 * The arithmetic a `<table>` would have done.
 *
 * Choosing a div tree bought the layout plan 06 needs and cost this: every index is ours to get
 * right. It is worth testing directly because an off-by-one here is invisible to everyone who is
 * not using a screen reader — the table looks perfect and announces "row 51 of 50".
 */

interface Row extends Record<string, unknown> { id: string }

const columns: ColumnDef<Row>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.id, priority: 'primary' },
  { id: 'score', header: 'Score', cell: (row) => row.id, align: 'end' },
  { id: 'notes', header: 'Notes', cell: (row) => row.id, priority: 'detail' },
]

describe('row indices', () => {
  it('puts the header at 1 and the first data row at 2', () => {
    expect(HEADER_ROW_INDEX).toBe(1)
    expect(ariaRowIndex(0)).toBe(2)
  })

  it('counts the header, so the count and the indices describe the same sequence', () => {
    // 214 data rows occupy indices 2…215, so the count is 215. Reporting 214 would make the last
    // row announce "row 215 of 214".
    expect(ariaRowCount(214)).toBe(215)
    expect(ariaRowIndex(213)).toBe(ariaRowCount(214))
  })

  it('offsets by the absolute position of the first loaded row', () => {
    expect(ariaRowIndex(0, 100)).toBe(102)
    expect(ariaRowIndex(49, 100)).toBe(151)
  })
})

describe('column indices', () => {
  it('are 1-based', () => {
    expect(ariaColIndex(0)).toBe(1)
    expect(ariaColIndex(3)).toBe(4)
  })
})

describe('grid template', () => {
  it('gives data columns a share of the space and control columns a fixed width', () => {
    expect(gridTemplateColumns(columns)).toBe('minmax(0, 1fr) minmax(0, max-content) minmax(0, 1fr)')
  })

  /** `minmax(0, …)` rather than `1fr`: without the zero minimum a long cell pushes the grid wider than its container, which is what makes a table scroll sideways on a laptop. */
  it('never lets a column claim a minimum width', () => {
    expect(gridTemplateColumns(columns)).not.toContain('auto ')
    expect(gridTemplateColumns(columns).split(' ').filter((part) => part === 'minmax(0,').length).toBe(3)
  })

  it('adds the selection and expansion columns when they are present', () => {
    const template = gridTemplateColumns(columns, { selectable: true, expandable: true })
    expect(template.startsWith('2.25rem ')).toBe(true)
    expect(template.endsWith(' 2.25rem')).toBe(true)
  })
})

describe('stacked priorities', () => {
  it('selects by priority', () => {
    expect(columnsForPriority(columns, ['primary']).map((column) => column.id)).toEqual(['name'])
    expect(columnsForPriority(columns, ['detail']).map((column) => column.id)).toEqual(['notes'])
  })

  /** A column author who says nothing gets the middle behaviour rather than disappearing. */
  it('treats an unset priority as secondary', () => {
    expect(columnsForPriority(columns, ['secondary']).map((column) => column.id)).toEqual(['score'])
  })
})

describe('cell alignment', () => {
  it('uses tabular figures for numeric columns', () => {
    expect(cellAlignmentClass(columns[1])).toContain('tabular-nums')
  })

  /** DESIGN.md:221 restricts a monospace face to literal code and keys. Aligning numbers is not that. */
  it('does not reach for a monospace face', () => {
    expect(cellAlignmentClass(columns[1])).not.toContain('mono')
  })

  it('leaves text columns alone', () => {
    expect(cellAlignmentClass(columns[0])).toBe('text-left')
  })
})
