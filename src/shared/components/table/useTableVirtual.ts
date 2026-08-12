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
 * Table row density, inherited from the table container.
 *
 * The reference's three: `sm` for large lists, `md` as the default, `lg` for rows carrying an
 * avatar. A *cell* may not choose its own height — the virtualizer measures nothing and computes
 * every offset as `index * rowHeight`, so one tall cell would put every row below it at the wrong
 * `translateY`. That is why density lives on the container as `data-density` and the cells simply
 * fill it.
 *
 * Deliberately **not** the dashboard's `BentoDensity`, which plan 06's checklist points at.
 * That preference is `'bento' | 'sections'` — a layout mode for the dashboard's widget grid — and
 * it moved from `localStorage` to a server-backed document since the plan was written. Binding row
 * height to it would mean switching the dashboard from bento to sections silently changed the row
 * height of every table, which nobody asked for. Row height is the table's own concept.
 */
export type TableDensity = 'sm' | 'md' | 'lg'

/**
 * **The** source of row-height truth.
 *
 * `globals.css` carries the same three numbers as `--tbl-row-height-{sm,md,lg}`, but only as the
 * fallback a table that sets no density resolves against: `DataTable` writes the value from this
 * record back onto the container as an inline `--tbl-row-height`, so the pixels CSS paints and the
 * pixels the virtualizer offsets by cannot drift apart. A mismatch there does not look broken — it
 * looks like rows slowly sliding out from under their own hover state as you scroll.
 */
export const ROW_HEIGHT: Record<TableDensity, number> = {
  sm: 44,
  md: 52,
  lg: 64,
}

/**
 * Search's result-card row height.
 *
 * Not a fourth density. A search row *is* a `PersonResultCard`, so it is a specialized renderer's
 * fixed height — but it is named here rather than left as a literal in `SearchPage.tsx`, because a
 * magic `176` in a surface file is exactly the local dimension this plan removes everywhere else.
 * Mirrored by `--tbl-row-height-search-card`.
 */
export const SEARCH_CARD_ROW_HEIGHT = 176

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
