import * as React from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  CircleUser, Users, CreditCard, Shield, Activity, Cog, Inbox, AlertTriangle,
  BookOpen, Map, LogOut, Sparkles, RotateCcw, ShieldAlert, Gauge,
} from 'lucide-react'
import { ICON_TRANSITION } from '~/shared/lib/useSlidingIndicator'
import { FLOATING_UI_Z } from '~/shared/components/Tooltip'
import { useTheme } from '~/shared/lib/theme/ThemeProvider'
import { motionTokens } from '~/shared/lib/motion/tokens'

const WORKSPACE_LINKS = [
  { to: '/settings/team', icon: Users, label: 'Team' },
  { to: '/settings/billing', icon: CreditCard, label: 'Billing' },
  { to: '/settings/privacy', icon: Shield, label: 'Privacy' },
  { to: '/status', icon: Activity, label: 'Status' },
] as const

const ADMIN_LINKS = [
  { to: '/admin/metrics', icon: Activity, label: 'Metrics' },
  { to: '/admin/users', icon: Users, label: 'Users' },
  { to: '/admin/plan-requests', icon: Inbox, label: 'Plan requests' },
  { to: '/admin/incidents', icon: AlertTriangle, label: 'Incidents' },
  { to: '/admin/changelog', icon: BookOpen, label: 'Changelog' },
  { to: '/admin/roadmap', icon: Map, label: 'Roadmap' },
  { to: '/admin/refunds', icon: RotateCcw, label: 'Refunds' },
  { to: '/admin/disputes', icon: ShieldAlert, label: 'Disputes' },
  { to: '/admin/billing', icon: Gauge, label: 'Billing ops' },
] as const

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
  isAdmin: boolean
  signingOut: boolean
  onSignOut: () => void
}

/**
 * Consolidates what used to be three separate topbar controls (admin flyout,
 * account link, sign-out button) into one avatar-triggered menu — same
 * portal + fixed-position + reposition/outside-click/Escape pattern as the
 * admin flyout it replaces, so floating-panel behavior stays consistent.
 */
export function UserMenu({ pathname, isAdmin, signingOut, onSignOut }: UserMenuProps) {
  const [open, setOpen] = React.useState(false)
  const [coords, setCoords] = React.useState({ top: 0, right: 0 })
  const [mounted, setMounted] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const { accent, setAccent } = useTheme()
  const reduceMotion = useReducedMotion()

  // `document.body` (below) doesn't exist during SSR — same mounted-gate
  // pattern as `TosModal.tsx`'s portal.
  React.useEffect(() => {
    setMounted(true)
  }, [])

  const reposition = React.useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setCoords({ top: rect.bottom + 8, right: window.innerWidth - rect.right })
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
              <MenuLink to="/me" icon={CircleUser} label="Account" active={isAccountActive} onNavigate={closeMenu} />

              <div className="mt-1 pt-1 border-t border-bh-border/60">
                {WORKSPACE_LINKS.map((item) => (
                  <MenuLink
                    key={item.to}
                    to={item.to}
                    icon={item.icon}
                    label={item.label}
                    active={pathname === item.to}
                    onNavigate={closeMenu}
                  />
                ))}
              </div>

              {isAdmin && (
                <div className="mt-1 pt-1 border-t border-bh-border/60">
                  <p className="px-3 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-bh-text-dim flex items-center gap-1.5">
                    <Cog className="w-3 h-3" aria-hidden="true" /> Admin
                  </p>
                  {ADMIN_LINKS.map((item) => (
                    <MenuLink
                      key={item.to}
                      to={item.to}
                      icon={item.icon}
                      label={item.label}
                      active={pathname === item.to}
                      onNavigate={closeMenu}
                    />
                  ))}
                </div>
              )}

              <div className="mt-1 pt-1.5 border-t border-bh-border/60 px-2 pb-1">
                <button
                  type="button"
                  onClick={() => setAccent(accent === 'neon' ? 'brand' : 'neon')}
                  aria-label={accent === 'neon' ? 'Use brand accent' : 'Use neon accent'}
                  aria-pressed={accent === 'neon'}
                  className="w-full flex items-center gap-2 text-xs font-medium text-bh-text-muted hover:text-bh-text px-2 py-1.5 rounded-lg hover:bg-bh-bg-alt transition-colors duration-150"
                >
                  <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  Accent: {accent === 'neon' ? 'Neon' : 'Brand'}
                </button>
              </div>

              <div className="pt-1 border-t border-bh-border/60">
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
