import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  className?: string
}

/**
 * Centered overlay dialog — portal + backdrop, dismissable via Escape or a
 * backdrop click. The only prior modal in the app (TosModal) is
 * intentionally non-dismissable (forces ToS acceptance), so it doesn't
 * have this logic; this is the first reusable, closable one.
 */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const titleId = React.useId()

  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`card w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 relative animate-fade-in-up ${className ?? ''}`}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id={titleId} className="text-lg font-semibold text-bh-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-bh-text-dim hover:text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
