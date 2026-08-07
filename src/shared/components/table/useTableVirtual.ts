import { useVirtualizer } from '@tanstack/react-virtual'
import * as React from 'react'

/**
 * Rendering a window instead of every loaded row.
 *
 * Pagination bounds what the database returns per request. It does not bound what the browser
 * holds: infinite scroll appends, so a minute of scrolling accumulates thousands of rows and every
 * later render, hover and re-sort pays for all of them. `SearchPage.tsx:418` does exactly this
 * today.
 *
 * The subtle part is not the windowing. It is the two things windowing quietly breaks.
 */

/**
 * Table row density.
 *
 * Deliberately **not** the dashboard's `BentoDensity`, which plan 06's checklist points at.
 * That preference is `'bento' | 'sections'` — a layout mode for the dashboard's widget grid — and
 * it moved from `localStorage` to a server-backed document since the plan was written. Binding row
 * height to it would mean switching the dashboard from bento to sections silently changed the row
 * height of every table, which nobody asked for. Row height is the table's own concept.
 */
export type TableDensity = 'comfortable' | 'compact'

export const ROW_HEIGHT: Record<TableDensity, number> = {
  comfortable: 40,
  compact: 34,
}

/** Rows kept mounted beyond the visible window, so a fast scroll does not show blank space. */
const DEFAULT_OVERSCAN = 8

export interface VirtualWindowItem {
  index: number
  /** Offset from the top of the scrolling content, in pixels. */
  start: number
  size: number
}

export interface TableVirtualOptions {
  count: number
  scrollRef: React.RefObject<HTMLElement | null>
  rowHeight: number
  /**
   * The row the roving tabindex is on. Forced into the window — see `pinFocusedIndex`.
   * `-1` when nothing is focused.
   */
  focusedIndex: number
  overscan?: number
  /** Off for small lists and for the board renderer. */
  enabled?: boolean
}

export interface TableVirtualResult {
  items: VirtualWindowItem[]
  totalSize: number
  enabled: boolean
}

/**
 * Keep the focused row in the window even when it has scrolled far out of it.
 *
 * **This is the hazard virtualization is separated into its own plan for.** A roving tabindex puts
 * `tabIndex={0}` on exactly one cell. Unmount that cell — which is precisely what a virtualizer
 * does when it scrolls out of range — and the browser moves focus to `<body>`. Keyboard navigation
 * then stops working mid-list, with no error, no visual cue, and only in lists long enough to
 * virtualize: the ones where a keyboard is most useful.
 *
 * Keeping one extra row mounted, positioned at its real offset so it is simply off-screen, costs
 * one DOM node and fixes it.
 */
export function pinFocusedIndex(
  items: VirtualWindowItem[],
  focusedIndex: number,
  rowHeight: number,
  count: number,
): VirtualWindowItem[] {
  if (focusedIndex < 0 || focusedIndex >= count) return items
  if (items.some((item) => item.index === focusedIndex)) return items
  const pinned: VirtualWindowItem = {
    index: focusedIndex,
    start: focusedIndex * rowHeight,
    size: rowHeight,
  }
  // Kept in index order so `aria-rowindex` ascends through the DOM, which is what a screen reader
  // reading the grid in document order expects.
  return [...items, pinned].sort((a, b) => a.index - b.index)
}

export function useTableVirtual(options: TableVirtualOptions): TableVirtualResult {
  const { count, scrollRef, rowHeight, focusedIndex, overscan = DEFAULT_OVERSCAN, enabled = true } = options

  const virtualizer = useVirtualizer({
    count: enabled ? count : 0,
    getScrollElement: () => scrollRef.current,
    // Exact, not an estimate: row height is fixed per density, so there is no measurement pass and
    // no layout shift as rows resolve. Variable heights would be a different plan.
    estimateSize: () => rowHeight,
    overscan,
  })

  const virtualItems = virtualizer.getVirtualItems()

  const items = React.useMemo(() => {
    if (!enabled) {
      return Array.from({ length: count }, (_, index) => ({
        index,
        start: index * rowHeight,
        size: rowHeight,
      }))
    }
    return pinFocusedIndex(
      virtualItems.map((item) => ({ index: item.index, start: item.start, size: item.size })),
      focusedIndex,
      rowHeight,
      count,
    )
  }, [enabled, count, rowHeight, virtualItems, focusedIndex])

  return {
    items,
    totalSize: enabled ? virtualizer.getTotalSize() : count * rowHeight,
    enabled,
  }
}
