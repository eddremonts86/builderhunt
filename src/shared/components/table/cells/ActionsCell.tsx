import { MoreHorizontal } from 'lucide-react'
import * as React from 'react'

interface ActionsCellProps {
  /** The one action worth a permanent button. Everything else belongs behind the overflow. */
  primary?: React.ReactNode
  /** Rendered inside a `role="menu"`. Each child should be a `role="menuitem"` button or link. */
  overflow?: React.ReactNode
  /**
   * Names the menu for a screen reader — "Actions for Ana Ruiz", not a fiftieth "More actions".
   *
   * Fifty identically-labelled buttons is what a rowwise action column produces by default, and it
   * makes the whole column unusable from a screen reader's element list.
   */
  label: string
}

/**
 * One visible action, plus an overflow menu. The row's only action column, and it sticks.
 *
 * The reference's constraint, and it is about the column rather than the buttons: three visible
 * actions per row across fifty rows is a hundred and fifty tab stops between the top of the table
 * and the bottom of it. One button and a menu is two, and the menu is where the destructive ones
 * belong anyway — a Delete that sits permanently under the cursor gets pressed.
 *
 * 44px wide (`--tbl-col-actions`), `position: sticky; right: 0` so it stays reachable while the
 * fixed-width middle columns scroll horizontally underneath.
 */
export function ActionsCell({ primary, overflow, label }: ActionsCellProps) {
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Escape closes, and focus goes back to the trigger. Without the second half, dismissing the menu
  // drops the keyboard user out of the grid entirely and they restart from the toolbar.
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  return (
    <div className="tbl-actions" ref={containerRef} data-testid="cell-actions">
      {primary}
      {overflow !== undefined && overflow !== null && (
        <div className="tbl-actions-overflow">
          <button
            type="button"
            ref={triggerRef}
            className="tbl-actions-trigger"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={label}
            onClick={() => setOpen((value) => !value)}
            data-testid="cell-actions-trigger"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
          {open && (
            <div className="tbl-actions-menu" role="menu" aria-label={label} data-testid="cell-actions-menu">
              {overflow}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
