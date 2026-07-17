import * as React from 'react'
import { createPortal } from 'react-dom'

/** Shared z-index for flyouts/tooltips that live above the floating topbars
 * (which sit at z-40) — see layout.md's "never arbitrary" z-index rule. */
export const FLOATING_UI_Z = 50

/**
 * Icon tooltip, portal + fixed-position. A `position: absolute` tooltip
 * anchored inside a floating topbar gets clipped: the topbar needs
 * `overflow-x-auto` for its own mobile horizontal-scroll fallback, and CSS
 * forces overflow-y to compute to `auto` too the moment overflow-x isn't
 * `visible` — there's no way to keep one axis truly visible once the other
 * scrolls (see interaction-design.md's dropdown-clipping note, same root
 * cause as the admin flyout panel). Portaling to `document.body` with
 * `position: fixed` escapes that clipping entirely.
 *
 * Shared by every floating topbar in the app (dashboard shell, landing
 * page) so hover/focus tooltip behavior is identical everywhere, not two
 * copies that can drift.
 */
export function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [coords, setCoords] = React.useState({ top: 0, left: 0 })
  const anchorRef = React.useRef<HTMLSpanElement>(null)

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setCoords({ top: rect.bottom + 8, left: rect.left + rect.width / 2 })
    setOpen(true)
  }
  const hide = () => setOpen(false)

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && createPortal(
        <span
          role="tooltip"
          aria-hidden="true"
          className="fixed pointer-events-none whitespace-nowrap rounded-md bg-bh-text px-2 py-1 text-[11px] font-medium text-white animate-fade-in motion-reduce:animate-none"
          style={{ top: coords.top, left: coords.left, transform: 'translateX(-50%)', zIndex: FLOATING_UI_Z }}
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  )
}
