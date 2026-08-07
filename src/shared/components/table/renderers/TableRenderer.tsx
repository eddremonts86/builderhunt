import { GridRow } from '../GridRow'
import { VirtualCanvas } from './VirtualCanvas'
import type { RendererContext } from './types'

/**
 * Rows in the order the server returned them. The default, and the one the other three vary from.
 *
 * It renders `context.window`, not `context.rows`. When virtualization is off the window covers
 * every entry, so there is one code path rather than a virtualized one and a fallback that drift.
 */
export function TableRenderer<Row>({ context }: { context: RendererContext<Row> }) {
  return (
    <VirtualCanvas context={context}>
      {(entry) => entry.kind === 'row'
        ? <GridRow key={entry.key} context={context} row={entry.row} index={entry.index} />
        : null}
    </VirtualCanvas>
  )
}
