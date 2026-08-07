import { GridRow } from '../GridRow'
import { GroupRow } from '../GroupRow'
import { VirtualCanvas } from './VirtualCanvas'
import type { RendererContext } from './types'

/**
 * The same rows, with a header wherever the grouped value changes.
 *
 * It does **not** group the data. The server ordered rows so a group is contiguous, and re-grouping
 * here would rearrange the loaded 50 of 214 into groups that fall apart on the next page. The
 * boundaries were computed once in `entries.ts`, where the group headers become entries in the same
 * flat list the virtualizer measures — outside it, their heights would be missing from the offset
 * arithmetic and every sticky position below the window would drift.
 */
export function GroupedRenderer<Row>({ context }: { context: RendererContext<Row> }) {
  const columnCount = context.columns.length + (context.selectable ? 1 : 0) + (context.expansion ? 1 : 0)

  return (
    <VirtualCanvas context={context}>
      {(entry) => entry.kind === 'group'
        ? (
          <GroupRow
            key={entry.key}
            value={entry.value}
            total={entry.total}
            loaded={entry.loaded}
            columnCount={columnCount}
          />
          )
        : <GridRow key={entry.key} context={context} row={entry.row} index={entry.index} />}
    </VirtualCanvas>
  )
}
