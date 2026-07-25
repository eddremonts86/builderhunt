import * as React from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  LayoutDashboard, Search, Download, Mail, Compass, Menu,
} from 'lucide-react'
import { signOut } from '~/shared/lib/auth/client'
import { BackToTop } from '~/shared/components/BackToTop'
import { BrandLogoMark } from '~/shared/components/BrandLogoMark'
import { Tooltip, FLOATING_UI_Z } from '~/shared/components/Tooltip'
import { ICON_TRANSITION, useSlidingIndicator, SlidingIndicator } from '~/shared/lib/useSlidingIndicator'
import { clampRightAnchoredPanel } from '~/shared/lib/floatingPanel'
import { OrganizationSwitcher } from '~/modules/dashboard/components/OrganizationSwitcher'
import { UserMenu } from '~/modules/dashboard/components/UserMenu'
import { ThemeToggle } from '~/shared/components/ThemeToggle'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'
import { motionTokens } from '~/shared/lib/motion/tokens'

/** Primary work surfaces — rendered as icon pills in the floating topbar.
 * Settings/account/admin items live in the user menu instead (see UserMenu). */
const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/search', icon: Search, label: 'Search', end: false },
  { to: '/sprints', icon: Compass, label: 'Sprints', end: false },
  { to: '/exports', icon: Download, label: 'Exports', end: false },
  { to: '/alerts', icon: Mail, label: 'Alerts', end: false },
] as const

/** Same set, minus the home-anchor pill that stays always-visible on mobile. */
const MOBILE_NAV_ITEMS = NAV.filter((n) => n.to !== '/dashboard')

function NavPill({
  to, icon: Icon, label, active, badge,
}: { to: string; icon: React.ComponentType<{ className?: string }>; label: string; active: boolean; badge?: number }) {
  return (
    <Link
      to={to}
      aria-label={label}
      data-active={active || undefined}
      className={`relative z-10 rounded-full flex items-center gap-2 h-10 px-4 text-sm font-semibold whitespace-nowrap ${ICON_TRANSITION} ${
        active ? 'text-white' : 'text-bh-text-dim hover:text-bh-text'
      }`}
    >
      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
      {label}
      {Boolean(badge) && (
        <span
          className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-bh-accent px-1 text-[0.625rem] font-bold text-white"
          data-testid="alerts-nav-badge"
        >
          {badge && badge > 9 ? '9+' : badge}
        </span>
      )}
    </Link>
  )
}

/** Below `md`, everything except the `Dashboard` home-anchor pill collapses
 * behind this hamburger-triggered sheet — same portal/fixed-position/
 * reposition-on-scroll/outside-click/Escape/viewport-clamp pattern as
 * `OrganizationSwitcher`/`UserMenu`, so the mobile nav doesn't invent a
 * fourth floating-panel behavior. `OrganizationSwitcher` and `UserMenu`
 * themselves stay always-visible (never enter this sheet) — they're already
 * compact icon/avatar-first triggers on desktop. */
function MobileNavSheet({ items, activePath }: {
  items: ReadonlyArray<{ to: string; icon: React.ComponentType<{ className?: string }>; label: string; end: boolean; badge?: number }>
  activePath: string
}) {
  const [open, setOpen] = React.useState(false)
  const [coords, setCoords] = React.useState({ top: 0, right: 0 })
  const [mounted, setMounted] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const reposition = React.useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More navigation"
        className={`relative w-9 h-9 rounded-full flex items-center justify-center text-bh-text-dim hover:text-bh-text hover:bg-bh-bg-alt ${ICON_TRANSITION}`}
      >
        <Menu className="w-4 h-4" aria-hidden="true" />
      </button>

      {mounted && createPortal(
        <AnimatePresence mode="wait">
          {open && (
            <motion.div
              ref={panelRef}
              role="menu"
              aria-label="More navigation"
              className="glass-panel fixed min-w-[200px] p-1.5"
              style={{ zIndex: FLOATING_UI_Z, top: coords.top, right: coords.right }}
              initial={{ opacity: 0, y: reduceMotion ? 0 : -8, scale: reduceMotion ? 1 : 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : -8, scale: reduceMotion ? 1 : 0.97 }}
              transition={{ duration: motionTokens.duration.fast, ease: motionTokens.easing.smooth }}
            >
              {items.map((item) => {
                const active = item.end ? activePath === item.to : activePath.startsWith(item.to)
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-colors duration-150 ${
                      active ? 'text-bh-accent bg-bh-accent-soft font-semibold' : 'text-bh-text-muted hover:text-bh-text hover:bg-bh-bg-alt'
                    }`}
                  >
                    <item.icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    {item.label}
                    {Boolean(item.badge) && (
                      <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-bh-accent px-1 text-[0.625rem] font-bold text-white">
                        {item.badge && item.badge > 9 ? '9+' : item.badge}
                      </span>
                    )}
                  </Link>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const reduceMotion = useReducedMotion()
  const [signingOut, setSigningOut] = React.useState(false)
  const [isAdmin, setIsAdmin] = React.useState(false)
  const [unreadAlertsCount, setUnreadAlertsCount] = React.useState(0)
  const pillRowRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    fetch('/api/admin/incidents', { credentials: 'include' })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false))
  }, [])

  React.useEffect(() => {
    fetch('/api/alerts/triggers/unread-count', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { count: 0 }))
      .then((data) => setUnreadAlertsCount(data.count ?? 0))
      .catch(() => setUnreadAlertsCount(0))
  }, [location.pathname])

  const indicator = useSlidingIndicator(pillRowRef, [location.pathname])

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      navigate({ to: '/auth/sign-in' })
    }
  }

  return (
    <div className="min-h-screen bg-app">
      {/* Floating topbar — glass surface, same fixed/inset-stretched shell as
          before. Trimmed to primary work sections; everything account/
          settings/admin-related now lives behind the UserMenu avatar. */}
      <motion.header
        initial={{ opacity: 0, y: reduceMotion ? 0 : -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: motionTokens.duration.normal, ease: motionTokens.easing.smooth }}
        className="glass-topbar fixed top-4 inset-x-4 md:inset-x-6 lg:inset-x-10 z-40 flex items-center justify-between gap-3 rounded-full px-3 py-2 overflow-x-auto"
        aria-label="Main navigation"
      >
        <Tooltip label="Back to home">
          <Link
            to="/"
            aria-label="BuilderHunt home"
            className={`relative flex items-center px-1.5 shrink-0 ${ICON_TRANSITION}`}
          >
            <BrandLogoMark />
          </Link>
        </Tooltip>

        {/* Desktop (md+): full pill row, pixel-unchanged. */}
        <div ref={pillRowRef} className="hidden md:relative md:flex items-center gap-1 rounded-full bg-bh-bg-alt/60 p-1">
          <SlidingIndicator rect={indicator} />
          {NAV.map((n) => (
            <NavPill
              key={n.to}
              to={n.to}
              icon={n.icon}
              label={n.label}
              active={n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)}
              badge={n.to === '/alerts' ? unreadAlertsCount : undefined}
            />
          ))}
        </div>

        {/* Mobile (<md): keep the Dashboard home-anchor pill always visible;
            collapse Search/Sprints/Exports/Alerts behind a hamburger sheet
            instead of relying on silent topbar horizontal scroll. */}
        <div className="flex md:hidden items-center gap-1">
          <Link
            to="/dashboard"
            aria-label="Dashboard"
            data-active={location.pathname === '/dashboard' || undefined}
            className={`relative w-9 h-9 rounded-full flex items-center justify-center ${ICON_TRANSITION} ${
              location.pathname === '/dashboard' ? 'bg-[#2b1812] text-white' : 'text-bh-text-dim hover:text-bh-text hover:bg-bh-bg-alt'
            }`}
          >
            <LayoutDashboard className="w-4 h-4" aria-hidden="true" />
          </Link>
          <MobileNavSheet
            items={MOBILE_NAV_ITEMS.map((item) => ({
              ...item,
              badge: item.to === '/alerts' ? unreadAlertsCount : undefined,
            }))}
            activePath={location.pathname}
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ThemeToggle />
          <OrganizationSwitcher />
          <UserMenu
            pathname={location.pathname}
            isAdmin={isAdmin}
            signingOut={signingOut}
            onSignOut={handleSignOut}
          />
        </div>
      </motion.header>

      {/* Main — one canonical content width for every dashboard page, so
          settings/sprints/search/admin all occupy the same horizontal
          space instead of each page picking its own max-w-*. */}
      <main className="pt-24 pb-8 px-4 lg:px-8">
        <div className="max-w-5xl mx-auto w-full">
          {children}
        </div>
      </main>

      <BackToTop />
    </div>
  )
}

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <DashboardLayoutInner>{children}</DashboardLayoutInner>
    </ThemeProvider>
  )
}
