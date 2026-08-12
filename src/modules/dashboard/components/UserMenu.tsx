import * as React from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CircleUser, LogOut } from 'lucide-react'
import { ICON_TRANSITION } from '~/shared/lib/useSlidingIndicator'
import { FLOATING_UI_Z } from '~/shared/components/Tooltip'
import { motionTokens } from '~/shared/lib/motion/tokens'
import { clampRightAnchoredPanel } from '~/shared/lib/floatingPanel'

function MenuLink({ to, icon: Icon, label, active, onNavigate }: {
  to: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  active: boolean
  onNavigate: () => void
}) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onNavigate}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-colors duration-150 ${
        active
          ? 'text-bh-accent bg-bh-accent-soft font-semibold'
          : 'text-bh-text-muted hover:text-bh-text hover:bg-bh-bg-alt'
      }`}
    >
      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
      {label}
    </Link>
  )
}

interface UserMenuProps {
  pathname: string
  signingOut: boolean
  onSignOut: () => void
  /**
   * Whether the global beta mode is on (plan 58).
   *
   * A prop, not a fetch of its own. This menu renders on every dashboard page, so a `useEffect` inside
   * it would issue one request per mount, per navigation — for a label. `DashboardLayout` already owns
   * the once-per-shell reads, so the menu stays presentational and testable without a network stub.
   */
  betaModeEnabled?: boolean
}

/**
 * Account and sign-out, and nothing else.
 *
 * This menu used to carry the 5 workspace settings pages and the 10 admin
 * destinations, because the old topbar had no room for them. The sidebar shell
 * lists all of them now (see `nav-config.ts`), so keeping copies here would mean
 * two competing navigations — the exact confusion the shell change set out to
 * remove. Session-scoped actions stay, since they belong to the avatar and not
 * to any area.
 */
export function UserMenu({ pathname, signingOut, onSignOut, betaModeEnabled = false }: UserMenuProps) {
  const [open, setOpen] = React.useState(false)
  const [coords, setCoords] = React.useState({ top: 0, right: 0 })
  const [mounted, setMounted] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()

  // `document.body` (below) doesn't exist during SSR — same mounted-gate
  // pattern as `TosModal.tsx`'s portal.
  React.useEffect(() => {
    setMounted(true)
  }, [])

  const reposition = React.useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    // Clamped so a trigger near the viewport's left edge (narrow phones)
    // can't push the panel's own left edge off-screen.
    const rawRight = window.innerWidth - rect.right
    const panelWidth = panelRef.current?.getBoundingClientRect().width ?? 0
    setCoords({ top: rect.bottom + 8, right: clampRightAnchoredPanel(rawRight, panelWidth) })
  }, [])

  React.useEffect(() => {
    if (!open) return
    reposition()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, reposition])

  const closeMenu = () => setOpen(false)
  const isAccountActive = pathname === '/me'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={`relative w-9 h-9 rounded-full flex items-center justify-center ${ICON_TRANSITION} ${
          isAccountActive || open
            ? 'bg-[#2b1812] text-white shadow-sm'
            : 'text-bh-text-dim hover:text-bh-text hover:bg-bh-bg-alt'
        }`}
      >
        <CircleUser className="w-4 h-4" aria-hidden="true" />
      </button>

      {mounted && createPortal(
        <AnimatePresence mode="wait">
          {open && (
            <motion.div
              ref={panelRef}
              role="menu"
              aria-label="Account"
              className="glass-panel fixed min-w-[240px] p-1.5"
              style={{ zIndex: FLOATING_UI_Z, top: coords.top, right: coords.right }}
              initial={{ opacity: 0, y: reduceMotion ? 0 : -8, scale: reduceMotion ? 1 : 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : -8, scale: reduceMotion ? 1 : 0.97 }}
              transition={{ duration: motionTokens.duration.fast, ease: motionTokens.easing.smooth }}
            >
              {/*
                Text, not a coloured dot.
                A member seeing Pro Max capabilities they did not pay for needs to know *why* they have
                them and that it is temporary — a dot says "something is on" and leaves them guessing.
                The allowance is in the copy for the same reason the admin control carries it: it is the
                part that changes what they can actually do.

                Absent when off, not rendered muted. There is nothing to tell someone about a promotion
                that is not running.
              */}
              {betaModeEnabled && (
                <p
                  className="mx-1 mb-1 rounded-lg bg-bh-accent-soft px-2.5 py-1.5 text-xs font-bold text-bh-accent"
                  data-testid="beta-mode-badge"
                >
                  Beta · 700 credits/month
                </p>
              )}

              <MenuLink to="/me" icon={CircleUser} label="Account" active={isAccountActive} onNavigate={closeMenu} />

              <div className="mt-1 pt-1 border-t border-bh-border/60">
                <button
                  type="button"
                  onClick={onSignOut}
                  disabled={signingOut}
                  role="menuitem"
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-left text-bh-text-muted hover:text-bh-danger hover:bg-bh-danger/10 disabled:opacity-50 transition-colors duration-150"
                >
                  {signingOut ? <span className="spinner" aria-hidden="true" /> : <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />}
                  Sign out
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
