import { GridRow } from '../GridRow'
import { GroupRow } from '../GroupRow'
import type { RendererContext } from './types'

/**
 * The same rows, with a sticky header wherever the grouped value changes.
 *
 * It does **not** group the data: the server already ordered rows so a group is contiguous, and
 * re-grouping here would reorder the loaded 50 of 214 into groups that do not survive the next
 * page. All this walk does is notice where the value changes — which is why it reads the value
 * through `ColumnDef.value`, the primitive behind the cell, rather than through the rendered node.
 */
export function GroupedRenderer<Row>({ context }: { context: RendererContext<Row> }) {
  const { rows, query, columns, page } = context
  const groupColumn = columns.find((column) => column.id === query.groupBy)

  if (!groupColumn) {
    return (
      <>
        {rows.map((row, index) => (
          <GridRow key={context.rowId(row)} context={context} row={row} index={index} />
        ))}
      </>
    )
  }

  const read = (row: Row): string => {
    const value = groupColumn.value?.(row)
    return value === null || value === undefined ? '—' : String(value)
  }

  // Loaded counts per group, for the "n loaded" half of the header. The other half comes from the
  // server's facet for this dimension.
  const loadedCounts = new Map<string, number>()
  for (const row of rows) {
    const value = read(row)
    loadedCounts.set(value, (loadedCounts.get(value) ?? 0) + 1)
  }
  const serverTotals = new Map(
    (page.facets[groupColumn.id] ?? []).map((facet) => [facet.value, facet.count]),
  )

  const columnCount = columns.length + (context.selectable ? 1 : 0) + (context.expansion ? 1 : 0)
  // Computed up front rather than with a variable carried across the map callback: a value that
  // survives between renders of a list is the shape React Compiler cannot reason about, and the
  // group boundaries are a property of the row array, not of the render.
  const groupValues = rows.map(read)
  const startsGroup = groupValues.map((value, index) => index === 0 || value !== groupValues[index - 1])

  return (
    <>
      {rows.map((row, index) => {
        const value = groupValues[index]
        return (
          <div key={context.rowId(row)} className="contents">
            {startsGroup[index] && (
              <GroupRow
                value={value}
                total={serverTotals.get(value) ?? null}
                loaded={loadedCounts.get(value) ?? 0}
                columnCount={columnCount}
              />
            )}
            <GridRow context={context} row={row} index={index} />
          </div>
        )
      })}
    </>
  )
}
