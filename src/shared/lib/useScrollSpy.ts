import * as React from 'react'

/**
 * Tracks which of the given section ids is currently most visible in the
 * viewport, so an anchor-link nav (no client-side "current route" to
 * compare against) can still highlight a "you are here" section — the
 * same active-state concept the dashboard shell gets for free from the
 * router, applied to a scrolling single page instead.
 */
export function useScrollSpy(ids: readonly string[]): string | null {
  const [activeId, setActiveId] = React.useState<string | null>(null)

  React.useEffect(() => {
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length === 0) return
        // Prefer the entry closest to the top of the viewport band.
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        setActiveId(visible[0].target.id)
      },
      // Treat a section as "current" once it's crossed into the upper
      // third of the viewport (roughly clear of the floating topbar) and
      // until it's scrolled past the middle.
      { rootMargin: '-15% 0px -60% 0px', threshold: 0 },
    )

    for (const el of elements) observer.observe(el)
    return () => observer.disconnect()
  }, [ids])

  return activeId
}
