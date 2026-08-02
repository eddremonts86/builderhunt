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
export function Tooltip({ label, items, placement = 'bottom', children }: {
  label: string
  /**
   * What is inside, for an icon that opens a whole area rather than performing one action.
   *
   * The rail's tooltips used to repeat the icon's own `aria-label` — "Admin" over an icon already captioned
   * Admin, which tells a user nothing they did not already know and is the reason the rail felt unnavigable.
   * Listing the pages the area actually contains answers the question the hover was asking: *where can I go?*
   * Section names do not answer it — "Operations" is not somewhere you can click to.
   *
   * Rendered one per line. A joined single line is unreadable past three entries and forces the box wide
   * enough to leave the screen.
   */
  items?: readonly string[]
  /**
   * `right` for the 60px icon rail, `bottom` for topbars.
   *
   * A rail icon sits ~30px from the left edge, so a bottom-centred tooltip is half off-screen and covers the
   * icons underneath it. Beside the rail there is a whole page of room.
   */
  placement?: 'bottom' | 'right'
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null)
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null)
  const anchorRef = React.useRef<HTMLSpanElement>(null)
  const tipRef = React.useRef<HTMLSpanElement>(null)

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setAnchor(rect)
    setCoords(null)
    setOpen(true)
  }
  const hide = () => setOpen(false)

  /**
   * Placed after measuring, not before.
   *
   * A multi-line tooltip's height is unknown until it renders, and beside a rail icon near the bottom of the
   * viewport a naive `translateY(-50%)` runs off the screen. Measuring in a layout effect corrects the position
   * before the browser paints, so there is no flash — and it is the only way to clamp against a size that does
   * not exist yet.
   */
  React.useLayoutEffect(() => {
    if (!open || !anchor || !tipRef.current) return
    const tip = tipRef.current.getBoundingClientRect()
    const GAP = 10
    const EDGE = 8
    const clamp = (value: number, size: number, viewport: number) =>
      Math.max(EDGE, Math.min(value, viewport - size - EDGE))

    setCoords(placement === 'right'
      ? {
          left: anchor.right + GAP,
          top: clamp(anchor.top + anchor.height / 2 - tip.height / 2, tip.height, window.innerHeight),
        }
      : {
          left: clamp(anchor.left + anchor.width / 2 - tip.width / 2, tip.width, window.innerWidth),
          top: anchor.bottom + GAP,
        })
  }, [open, anchor, placement])

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
        /**
         * `bg-bh-surface` + `text-bh-text`, not `bg-bh-text` + `text-white`.
         *
         * The old pair was **invisible in dark mode**: `--color-bh-text` is near-black in light and near-white
         * in dark, so pairing it with a hard-coded white gave white-on-white the moment the theme flipped. The
         * pair here moves together — both tokens flip with the theme, so the contrast holds in both by
         * construction rather than by having been checked once.
         *
         * A border and a shadow because a surface-coloured tooltip over a surface-coloured panel would
         * otherwise have no edge.
         */
        <span
          ref={tipRef}
          role="tooltip"
          aria-hidden="true"
          className="fixed pointer-events-none max-w-[15rem] min-w-[8.5rem] rounded-lg border border-bh-border bg-bh-surface px-3 py-2 text-[11px] text-bh-text shadow-lg animate-fade-in motion-reduce:animate-none"
          style={{
            top: coords?.top ?? 0,
            left: coords?.left ?? 0,
            // Hidden for the one frame between mount and measurement. `display` would collapse the box and
            // make the measurement zero; `visibility` keeps it laid out but unpainted.
            visibility: coords ? 'visible' : 'hidden',
            zIndex: FLOATING_UI_Z,
          }}
        >
          <span className="block font-semibold whitespace-nowrap">{label}</span>
          {items && items.length > 0 && (
            /**
             * One page per line, not a joined string. These are destinations — a reader scans them for the one
             * they want, and a scan needs rows. `·`-joined they reflow into a paragraph where no entry has an
             * edge, which is exactly how the first attempt shipped and why it was unreadable.
             */
            <span className="mt-1.5 block border-t border-bh-border pt-1.5 text-bh-text-muted">
              {items.map((item) => (
                <span key={item} className="block truncate leading-[1.6]">{item}</span>
              ))}
            </span>
          )}
        </span>,
        document.body,
      )}
    </span>
  )
}
