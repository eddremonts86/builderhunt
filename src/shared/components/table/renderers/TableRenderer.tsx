import { GridRow } from '../GridRow'
import type { RendererContext } from './types'

/**
 * Rows in the order the server returned them. The default, and the one the other three are
 * variations on.
 */
export function TableRenderer<Row>({ context }: { context: RendererContext<Row> }) {
  return (
    <>
      {context.rows.map((row, index) => (
        <GridRow key={context.rowId(row)} context={context} row={row} index={index} />
      ))}
    </>
  )
}
