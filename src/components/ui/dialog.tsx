import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '~/shared/lib/utils'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  className?: string
  /** Focus this element on open instead of Radix's default (first focusable
   * descendant, or the dialog panel itself). Use when a specific control —
   * not just "the first one in DOM order" — is the intentional starting
   * point (e.g. a search input rather than a leading close/icon button). */
  initialFocusRef?: React.RefObject<HTMLElement | null>
  /**
   * Where focus goes when the dialog closes.
   *
   * Radix restores to whatever held focus when the dialog opened — which works when it was opened by
   * `DialogPrimitive.Trigger`, and does not when it was opened by a state change from a button
   * elsewhere in the tree. In that case there is no recorded trigger, and a keyboard user closing
   * with Escape lands on `<body>` with no visible focus. `PublicNavDrawer` hit the same thing and
   * solves it the same way; this makes the fix available to every caller instead of one.
   *
   * Focusing the trigger from the caller's `onClose` is *not* equivalent: Radix's own
   * `onCloseAutoFocus` runs afterwards and moves focus again.
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

/**
 * Centered overlay dialog, built on @radix-ui/react-dialog for real
 * focus-trap/scroll-lock/portal/focus-restore behavior instead of a
 * hand-rolled Escape-listener version — same (open, onClose, title,
 * children, className) API as before, so existing callers (e.g. SearchPage's
 * filters dialog) don't need to change. Radix already: traps Tab/Shift+Tab
 * inside the content, marks background content inert, locks body scroll,
 * closes on Escape, and restores focus to the trigger that opened it on
 * close/unmount — `initialFocusRef` only overrides *where* focus lands on
 * open.
 */
export function Dialog({ open, onClose, title, children, className, initialFocusRef, returnFocusRef }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={
            initialFocusRef
              ? (event) => {
                  event.preventDefault()
                  initialFocusRef.current?.focus()
                }
              : undefined
          }
          onCloseAutoFocus={
            returnFocusRef
              ? (event) => {
                  event.preventDefault()
                  returnFocusRef.current?.focus()
                }
              : undefined
          }
          className={cn(
            'card fixed left-1/2 top-1/2 z-50 w-full max-w-[40rem] min-h-[566px] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6 animate-fade-in-up focus:outline-none',
            className,
          )}
        >
          <div className="flex items-center justify-between mb-4">
            <DialogPrimitive.Title className="text-lg font-semibold text-bh-text">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              className="p-1.5 rounded-lg text-bh-text-dim hover:text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
