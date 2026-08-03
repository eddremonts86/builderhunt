import * as React from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { X } from 'lucide-react'
import { FLOATING_UI_Z } from '~/shared/components/Tooltip'
import { motionTokens } from '~/shared/lib/motion/tokens'
import { groupedItems, isItemActive, type NavArea } from './nav-config'

/**
 * Below `lg` the two levels of shell C collapse into one drawer.
 *
 * Two 60px+212px columns would eat most of a phone's width, and a rail whose
 * second level lives off-screen is worse than no rail. So the drawer flattens
 * the hierarchy: every area becomes a heading and its destinations sit under it,
 * one scrollable list.
 */
export function MobileNavDrawer({
  open, onClose, areas, activeAreaId, pathname, badges,
}: {
  open: boolean
  onClose: () => void
  areas: readonly NavArea[]
  activeAreaId: string
  pathname: string
  badges: { unreadAlerts: number }
}) {
  const [mounted, setMounted] = React.useState(false)
  const reduceMotion = useReducedMotion()
  const panelRef = React.useRef<HTMLDivElement>(null)

  // `document.body` doesn't exist during SSR — same mounted gate as the other
  // portalled panels in this shell.
  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    // The drawer covers the page; letting the body scroll behind it means a
    // flick on the overlay scrolls content the user can't see.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  React.useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!mounted) return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="lg:hidden" style={{ zIndex: FLOATING_UI_Z }}>
          <motion.div
            className="fixed inset-0 bg-bh-text/25"
            style={{ zIndex: FLOATING_UI_Z }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: motionTokens.duration.fast }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            tabIndex={-1}
            className="fixed inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col bg-bh-surface shadow-2xl outline-none"
            style={{ zIndex: FLOATING_UI_Z + 1 }}
            initial={{ x: reduceMotion ? 0 : '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: reduceMotion ? 0 : '-100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          >
            <div className="flex min-h-[57px] items-center justify-between border-b border-bh-border px-4">
              <b className="text-[0.9375rem] font-bold tracking-tight">Navigation</b>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close navigation"
                className="grid h-8 w-8 place-items-center rounded-full text-bh-text-dim hover:bg-bh-bg-alt hover:text-bh-text"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {areas.map((area) => (
                <div key={area.id} className="mb-1">
                  <p className="flex items-center gap-2 px-3 pb-1 pt-3 font-mono text-[0.625rem] uppercase tracking-[0.11em] text-bh-text-dim">
                    <area.icon className="h-3 w-3" aria-hidden="true" />
                    {area.label}
                  </p>
                  {groupedItems(area).flatMap((group) => group.items).map((item) => {
                    const active = area.id === activeAreaId && isItemActive(item, pathname)
                    const count = item.badge ? badges[item.badge] : 0
                    return (
                      <Link
                        key={`${area.id}-${item.to}-${item.label}`}
                        to={item.to}
                        onClick={onClose}
                        aria-current={active ? 'page' : undefined}
                        className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors duration-150 ${
                          active
                            ? 'bg-bh-accent-soft font-semibold text-bh-accent'
                            : 'text-bh-text-muted hover:bg-bh-bg-alt hover:text-bh-text'
                        }`}
                      >
                        <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{item.label}</span>
                        {count > 0 && (
                          <span className="ml-auto inline-grid h-4 min-w-4 place-items-center rounded-full bg-bh-accent px-1 text-[0.625rem] font-bold text-bh-accent-contrast">
                            {count > 9 ? '9+' : count}
                          </span>
                        )}
                      </Link>
                    )
                  })}
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
