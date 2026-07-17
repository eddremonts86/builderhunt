import * as React from 'react'

/** Shared hover/focus micro-lift for every icon-only trigger in a floating
 * topbar — same constant used by the dashboard shell and the landing page
 * so the feel is identical, not two hand-tuned copies. */
export const ICON_TRANSITION =
  'transition-[color,background-color,transform] duration-200 ease-out hover:scale-110 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100'

/**
 * Measures the currently-active pill (marked `data-active="true"`) inside
 * `containerRef` and returns coordinates for a shared sliding background,
 * so switching sections morphs the pill instead of snapping between items.
 * Runs in a layout effect so it settles before paint — no flash on mount.
 *
 * Shared by every floating topbar's nav row (dashboard: active route:
 * landing: active scroll-spied section) so "which section is highlighted"
 * animates the same way everywhere.
 */
export function useSlidingIndicator(containerRef: React.RefObject<HTMLElement | null>, deps: React.DependencyList) {
  const [rect, setRect] = React.useState({ left: 0, width: 0, visible: false })

  React.useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const activeEl = container.querySelector<HTMLElement>('[data-active="true"]')
      if (!activeEl) {
        setRect((r) => ({ ...r, visible: false }))
        return
      }
      const cRect = container.getBoundingClientRect()
      const aRect = activeEl.getBoundingClientRect()
      setRect({ left: aRect.left - cRect.left + container.scrollLeft, width: aRect.width, visible: true })
    }
    measure()
    window.addEventListener('resize', measure)
    container.addEventListener('scroll', measure)
    return () => {
      window.removeEventListener('resize', measure)
      container.removeEventListener('scroll', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return rect
}

/** The dark sliding-pill background shared by both floating topbars. Render
 * as the first child of a `position: relative` row, with each nav item
 * `position: relative z-10` above it and one item marked `data-active`. */
export function SlidingIndicator({ rect }: { rect: { left: number; width: number; visible: boolean } }) {
  return (
    <span
      className="absolute inset-y-0 rounded-full bg-[#2b1812] shadow-sm transition-[left,width,opacity] duration-300 ease-out motion-reduce:transition-none"
      style={{ left: rect.left, width: rect.width, opacity: rect.visible ? 1 : 0 }}
      aria-hidden="true"
    />
  )
}
