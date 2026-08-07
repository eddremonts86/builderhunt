import type { ReactNode } from 'react'

import type { TableEntry } from '../entries'
import type { VirtualWindowItem } from '../useTableVirtual'
import type { RendererContext } from './types'

interface VirtualCanvasProps<Row> {
  context: RendererContext<Row>
  children: (entry: TableEntry<Row>, item: VirtualWindowItem) => ReactNode
}

/**
 * The scrolling surface a windowed list needs, and nothing when it does not need one.
 *
 * With virtualization on, the container is `position: relative` at the full height of the list so
 * the scrollbar reflects every row, and each mounted row is absolutely positioned at its real
 * offset. That is also what keeps the pinned focused row honest: it is mounted at its true position
 * and simply off-screen, rather than parked at the top of the window where a click would land on
 * the wrong row.
 *
 * With virtualization off, it renders the children in flow. Two structures, one call site, so a
 * renderer never grows a virtualized path and a fallback path that drift apart.
 */
export function VirtualCanvas<Row>({ context, children }: VirtualCanvasProps<Row>) {
  const { entries, window: items, totalSize, virtualized } = context

  if (!virtualized) {
    return <>{items.map((item) => children(entries[item.index], item)).filter(Boolean)}</>
  }

  return (
    <div style={{ height: totalSize, position: 'relative' }} data-testid="table-virtual-canvas">
      {items.map((item) => {
        const entry = entries[item.index]
        if (!entry) return null
        return (
          <div
            key={entry.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`,
              height: item.size,
            }}
          >
            {children(entry, item)}
          </div>
        )
      })}
    </div>
  )
}
