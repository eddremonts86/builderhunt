import { describe, expect, it } from 'vitest'

import {
  ariaColIndex,
  ariaRowCount,
  ariaRowIndex,
  cellAlignmentClass,
  columnsForPriority,
  gridMinWidth,
  gridTemplateColumns,
  HEADER_ROW_INDEX,
} from '~/shared/components/table/grid-roles'
import { isSortable, type ColumnDef } from '~/shared/lib/table/columns'

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

describe('grid template — unclassified columns (the compatibility default)', () => {
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
    expect(template.startsWith('var(--tbl-col-select) ')).toBe(true)
    expect(template.endsWith(' var(--tbl-col-expand)')).toBe(true)
  })

  /** No fixed track anywhere means no floor, so an unmigrated table behaves exactly as before. */
  it('claims no minimum width at all', () => {
    expect(gridMinWidth(columns)).toBe(0)
    expect(gridMinWidth(columns, { selectable: true, expandable: true })).toBe(0)
  })
})

describe('grid template — the canonical column kinds', () => {
  const classified: ColumnDef<Row>[] = [
    { id: 'name', header: 'Name', kind: 'primary', cell: (row) => row.id },
    { id: 'state', header: 'State', kind: 'status', cell: (row) => row.id },
    { id: 'seen', header: 'Last seen', kind: 'date', cell: (row) => row.id },
    { id: 'count', header: 'Count', kind: 'number', cell: (row) => row.id },
    { id: 'act', header: 'Actions', kind: 'actions', cell: (row) => row.id },
  ]

  /**
   * The reference's rule, and the reason the template is not `1fr` five times. A date sharing the
   * free space with everything else truncates on a narrow screen, and a half-shown date is a wrong
   * date.
   */
  it('makes only the primary column flexible', () => {
    expect(gridTemplateColumns(classified)).toBe(
      'var(--tbl-col-primary) var(--tbl-col-status) var(--tbl-col-date) var(--tbl-col-number) var(--tbl-col-actions)',
    )
  })

  it.each([
    ['status', 'var(--tbl-col-status)'],
    ['category', 'var(--tbl-col-category)'],
    ['date', 'var(--tbl-col-date)'],
    ['number', 'var(--tbl-col-number)'],
    ['ratio', 'var(--tbl-col-ratio)'],
    ['actions', 'var(--tbl-col-actions)'],
    ['empty', 'var(--tbl-col-empty)'],
  ] as const)('gives %s its own fixed track', (kind, track) => {
    expect(gridTemplateColumns([{ id: 'c', header: 'C', kind, cell: () => null }])).toBe(track)
  })

  it('gives identity a flexible track of its own, narrower than primary', () => {
    expect(gridTemplateColumns([{ id: 'who', header: 'Who', kind: 'identity', cell: () => null }]))
      .toBe('var(--tbl-col-identity)')
  })

  /**
   * The widths are token names, never numbers — a second copy of `116px` here is a second source of
   * truth, and the one that gets missed when a designer changes the first.
   */
  it('names tokens rather than pixel values', () => {
    expect(gridTemplateColumns(classified)).not.toMatch(/\d+px/)
  })
})

describe('the minimum width the scroller has to honour', () => {
  const classified: ColumnDef<Row>[] = [
    { id: 'name', header: 'Name', kind: 'primary', cell: () => null },
    { id: 'state', header: 'State', kind: 'status', cell: () => null },
    { id: 'seen', header: 'Seen', kind: 'date', cell: () => null },
  ]

  /**
   * Every row is its own CSS grid. They only stay in column with each other if they share a floor,
   * and the floor has to be computed here because CSS cannot hand JS a track's resolved width.
   *
   * 240 (primary) + 116 (status) + 168 (date) + 2 gaps × 20 + 2 × 16 padding = 596.
   */
  it('adds the fixed tracks, the inter-column gaps and the inline padding', () => {
    expect(gridMinWidth(classified)).toBe(240 + 116 + 168 + 2 * 20 + 2 * 16)
  })

  it('counts the selection and expansion columns and the gaps they add', () => {
    expect(gridMinWidth(classified, { selectable: true, expandable: true }))
      .toBe(240 + 116 + 168 + 36 + 36 + 4 * 20 + 2 * 16)
  })
})

describe('sort eligibility', () => {
  /** The reference: text, dates and numbers only. */
  it.each(['primary', 'category', 'date', 'number', 'identity', 'ratio'] as const)(
    'honours sortable on a %s column',
    (kind) => {
      expect(isSortable({ id: 'c', header: 'C', kind, sortable: true, cell: () => null })).toBe(true)
    },
  )

  /**
   * Ordering by a status column sorts by the internal enum's *spelling* — `active`, `blocked`,
   * `pending` — which is an order nobody means, and the header would still announce `aria-sort` to
   * a screen reader. Actions have no value to order by at all.
   */
  it.each(['status', 'actions'] as const)('refuses to expose sorting on a %s column', (kind) => {
    expect(isSortable({ id: 'c', header: 'C', kind, sortable: true, cell: () => null })).toBe(false)
  })

  it('never invents sorting for a column that did not ask for it', () => {
    expect(isSortable({ id: 'c', header: 'C', kind: 'date', cell: () => null })).toBe(false)
  })

  /** An unclassified column keeps its author's intent, because nothing knows better yet. */
  it('honours sortable on an unclassified column', () => {
    expect(isSortable({ id: 'c', header: 'C', sortable: true, cell: () => null })).toBe(true)
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

  /**
   * A column author should not have to remember `align: 'end'` on every count in the app — and
   * must not be able to forget it on one. The kind decides.
   */
  it.each(['number', 'ratio', 'actions'] as const)('aligns a %s column to the trailing edge by its kind alone', (kind) => {
    expect(cellAlignmentClass({ id: 'c', header: 'C', kind, cell: () => null })).toContain('text-right')
  })

  /** DESIGN.md:221 restricts a monospace face to literal code and keys. Aligning numbers is not that. */
  it('does not reach for a monospace face', () => {
    expect(cellAlignmentClass(columns[1])).not.toContain('mono')
  })

  it('leaves text columns alone', () => {
    expect(cellAlignmentClass(columns[0])).toBe('text-left')
  })
})
