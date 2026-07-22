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
}

/**
 * Centered overlay dialog, now built on @radix-ui/react-dialog for real
 * focus-trap/scroll-lock/portal behavior instead of the hand-rolled
 * Escape-listener version — same (open, onClose, title, children, className)
 * API as before, so existing callers (e.g. SearchPage's filters dialog)
 * don't need to change.
 */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
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
