import { describe, expect, it } from 'vitest'

import { buildTableEntries } from '~/shared/components/table/entries'
import { pinFocusedIndex, ROW_HEIGHT, SEARCH_CARD_ROW_HEIGHT, type VirtualWindowItem } from '~/shared/components/table/useTableVirtual'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { TableQuery } from '~/shared/lib/table/types'

/**
 * The focus pin, tested as the pure function it is.
 *
 * The hazard is worth restating because it is invisible: a roving tabindex puts `tabIndex={0}` on
 * one cell, a virtualizer unmounts that cell when it scrolls out of range, and the browser moves
 * focus to `<body>`. Keyboard navigation then stops working with no error and no visual cue, in
 * exactly the long lists virtualization exists for.
 */

const window16to24: VirtualWindowItem[] = Array.from({ length: 9 }, (_, offset) => ({
  index: 16 + offset,
  start: (16 + offset) * 40,
  size: 40,
}))

describe('pinFocusedIndex', () => {
  it('leaves the window alone when the focused row is already in it', () => {
    expect(pinFocusedIndex(window16to24, 20, 40, 500)).toBe(window16to24)
  })

  /** The whole point: the focused row stays mounted however far the list has scrolled past it. */
  it('adds the focused row when it has scrolled far out of the window', () => {
    const pinned = pinFocusedIndex(window16to24, 3, 40, 500)
    expect(pinned.map((item) => item.index)).toContain(3)
    expect(pinned).toHaveLength(window16to24.length + 1)
  })

  it('positions the pinned row at its real offset, not at the top of the window', () => {
    const pinned = pinFocusedIndex(window16to24, 3, 40, 500)
    // 3 × 40px. Parking it at the window's top would put a clickable row over the wrong content.
    expect(pinned.find((item) => item.index === 3)?.start).toBe(120)
  })

  /** A screen reader reads the grid in document order, so `aria-rowindex` has to ascend through the DOM. */
  it('keeps the window in index order', () => {
    const pinned = pinFocusedIndex(window16to24, 3, 40, 500)
    const indices = pinned.map((item) => item.index)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  it('pins a row below the window too', () => {
    const pinned = pinFocusedIndex(window16to24, 480, 40, 500)
    expect(pinned.at(-1)?.index).toBe(480)
  })

  it('pins nothing when no row is focused', () => {
    expect(pinFocusedIndex(window16to24, -1, 40, 500)).toBe(window16to24)
  })

  it('pins nothing for an index outside the list', () => {
    expect(pinFocusedIndex(window16to24, 900, 40, 500)).toBe(window16to24)
  })
})

describe('row height', () => {
  /**
   * Fixed per density, which is what makes `estimateSize` exact: no measurement pass, and no layout
   * shift as rows resolve to their real height.
   */
  it('is exact rather than estimated', () => {
    expect(ROW_HEIGHT.sm).toBe(44)
    expect(ROW_HEIGHT.md).toBe(52)
    expect(ROW_HEIGHT.lg).toBe(64)
  })

  /**
   * The reference's three densities, and the only three. A fourth would need a matching
   * `--tbl-row-height-*` fallback in globals.css and a matching `[data-density]` rule; this is the
   * assertion that makes adding one deliberate rather than accidental.
   */
  it('offers exactly the three container densities', () => {
    expect(Object.keys(ROW_HEIGHT).sort()).toEqual(['lg', 'md', 'sm'])
  })

  /**
   * Search's result-card row is a named token rather than a literal in `SearchPage.tsx`, but it is
   * deliberately *not* a fourth density — a card row is a specialized renderer's height, and adding
   * it to `ROW_HEIGHT` would offer it to every table in the app.
   */
  it('keeps the search result-card height out of the density scale', () => {
    expect(SEARCH_CARD_ROW_HEIGHT).toBe(176)
    expect(Object.values(ROW_HEIGHT)).not.toContain(SEARCH_CARD_ROW_HEIGHT)
  })
})

interface Row extends Record<string, unknown> { id: string; source: string }

const columns: ColumnDef<Row>[] = [
  { id: 'id', header: 'ID', cell: (row) => row.id, value: (row) => row.id },
  { id: 'source', header: 'Source', cell: (row) => row.source, value: (row) => row.source, groupable: true },
]

const rows: Row[] = [
  { id: 'a', source: 'github' },
  { id: 'b', source: 'github' },
  { id: 'c', source: 'gitlab' },
]

const query: TableQuery = { search: '', filters: {}, sort: [], groupBy: 'source' }

describe('the flat list the virtualizer measures', () => {
  it('is just the rows when grouping is off', () => {
    const entries = buildTableEntries({
      rows, columns, query: { ...query, groupBy: null }, facets: {}, rowId: (row) => row.id, grouped: false,
    })
    expect(entries.map((entry) => entry.kind)).toEqual(['row', 'row', 'row'])
  })

  /**
   * Group headers are entries, not DOM outside the list. Outside it, their heights would be missing
   * from the virtualizer's offset arithmetic and every sticky position below the window would drift
   * further the deeper you scroll.
   */
  it('interleaves group headers as items of the same list', () => {
    const entries = buildTableEntries({
      rows,
      columns,
      query,
      facets: { source: [{ value: 'github', count: 140 }, { value: 'gitlab', count: 74 }] },
      rowId: (row) => row.id,
      grouped: true,
    })
    expect(entries.map((entry) => entry.kind)).toEqual(['group', 'row', 'row', 'group', 'row'])
  })

  it('carries the server total on the header, and null when the server sent no facet', () => {
    const withFacets = buildTableEntries({
      rows, columns, query, facets: { source: [{ value: 'github', count: 140 }] }, rowId: (row) => row.id, grouped: true,
    })
    const github = withFacets.find((entry) => entry.kind === 'group' && entry.value === 'github')
    const gitlab = withFacets.find((entry) => entry.kind === 'group' && entry.value === 'gitlab')
    expect(github).toMatchObject({ total: 140, loaded: 2 })
    expect(gitlab).toMatchObject({ total: null, loaded: 1 })
  })

  /** Row indices are positions in the loaded rows, not in the entry list — the keyboard model counts rows. */
  it('keeps row indices independent of the interleaved headers', () => {
    const entries = buildTableEntries({ rows, columns, query, facets: {}, rowId: (row) => row.id, grouped: true })
    const rowIndices = entries.filter((entry) => entry.kind === 'row').map((entry) => entry.index)
    expect(rowIndices).toEqual([0, 1, 2])
  })
})
