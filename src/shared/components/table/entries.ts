import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'

/**
 * The flat list the virtualizer measures.
 *
 * Group headers are **entries in this list**, not DOM rendered outside it. If they lived outside,
 * every group header above the window would be missing from the virtualizer's offset arithmetic and
 * the sticky positions would drift by the height of the headers already scrolled past — a
 * misalignment that grows the further down the list you go, which is the hardest kind to reproduce.
 */
export type TableEntry<Row> =
  | {
    kind: 'group'
    key: string
    value: string
    /** The server's count for the whole group, or `null` when it sent no facet for the dimension. */
    total: number | null
    loaded: number
  }
  | { kind: 'row'; key: string; row: Row; index: number }

export interface BuildEntriesInput<Row> {
  rows: Row[]
  columns: ColumnDef<Row>[]
  query: TableQuery
  facets: PageResult<Row>['facets']
  rowId: (row: Row) => string
  grouped: boolean
}

export function buildTableEntries<Row>(input: BuildEntriesInput<Row>): TableEntry<Row>[] {
  const { rows, columns, query, facets, rowId, grouped } = input

  if (!grouped || query.groupBy === null) {
    return rows.map((row, index) => ({ kind: 'row', key: rowId(row), row, index }))
  }

  const groupColumn = columns.find((column) => column.id === query.groupBy)
  if (!groupColumn) return rows.map((row, index) => ({ kind: 'row', key: rowId(row), row, index }))

  // Read through `ColumnDef.value`, the primitive behind the cell — the rendered node may be an
  // avatar beside a name, and two rows in the same group would not compare equal.
  const read = (row: Row): string => {
    const value = groupColumn.value?.(row)
    return value === null || value === undefined ? '—' : String(value)
  }

  const loadedCounts = new Map<string, number>()
  for (const row of rows) {
    const value = read(row)
    loadedCounts.set(value, (loadedCounts.get(value) ?? 0) + 1)
  }
  const serverTotals = new Map((facets[groupColumn.id] ?? []).map((facet) => [facet.value, facet.count]))

  const entries: TableEntry<Row>[] = []
  let previous: string | null = null
  rows.forEach((row, index) => {
    const value = read(row)
    if (value !== previous) {
      entries.push({
        kind: 'group',
        key: `group:${value}`,
        value,
        total: serverTotals.get(value) ?? null,
        loaded: loadedCounts.get(value) ?? 0,
      })
      previous = value
    }
    entries.push({ kind: 'row', key: rowId(row), row, index })
  })
  return entries
}
