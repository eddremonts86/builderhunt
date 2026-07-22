import * as React from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  LayoutDashboard, Search, Download, Mail, CreditCard, Shield, Activity,
  Cog, Users, Inbox, AlertTriangle, BookOpen, Map, CircleUser, LogOut, Compass,
} from 'lucide-react'
import { signOut } from '~/shared/lib/auth/client'
import { BackToTop } from '~/shared/components/BackToTop'
import { BrandLogoMark } from '~/shared/components/BrandLogoMark'
import { Tooltip, FLOATING_UI_Z } from '~/shared/components/Tooltip'
import { ICON_TRANSITION, useSlidingIndicator, SlidingIndicator } from '~/shared/lib/useSlidingIndicator'
import { OrganizationSwitcher } from '~/modules/dashboard/components/OrganizationSwitcher'

/** Primary sections — rendered as icon pills in the floating topbar. */
const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/search', icon: Search, label: 'Search', end: false },
  { to: '/sprints', icon: Compass, label: 'Sprints', end: false },
  { to: '/exports', icon: Download, label: 'Exports', end: false },
  { to: '/alerts', icon: Mail, label: 'Alerts', end: false },
  { to: '/settings/team', icon: Users, label: 'Team', end: false },
  { to: '/settings/billing', icon: CreditCard, label: 'Billing', end: false },
  { to: '/settings/privacy', icon: Shield, label: 'Privacy', end: false },
  { to: '/status', icon: Activity, label: 'Status', end: false },
] as const

/** Admin-only routes — collapsed behind one flyout so they don't crowd the topbar. */
const ADMIN_NAV = [
  { to: '/admin/metrics', icon: Activity, label: 'Metrics' },
  { to: '/admin/users', icon: Users, label: 'Users' },
  { to: '/admin/plan-requests', icon: Inbox, label: 'Plan requests' },
  { to: '/admin/incidents', icon: AlertTriangle, label: 'Incidents' },
  { to: '/admin/changelog', icon: BookOpen, label: 'Changelog' },
  { to: '/admin/roadmap', icon: Map, label: 'Roadmap' },
] as const

function NavPill({
  to, icon: Icon, label, active,
}: { to: string; icon: React.ComponentType<{ className?: string }>; label: string; active: boolean }) {
  const link = (
    <Link
      to={to}
      aria-label={label}
      data-active={active || undefined}
      className={`relative z-10 rounded-full flex items-center justify-center ${ICON_TRANSITION} ${
        active
          ? 'gap-2 pl-3 pr-4 h-9 text-white text-xs font-semibold whitespace-nowrap'
          : 'w-9 h-9 text-bh-text-dim hover:text-bh-text'
      }`}
    >
      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
      {active && label}
    </Link>
  )
  return active ? link : <Tooltip label={label}>{link}</Tooltip>
}

function AdminFlyout({ pathname }: { pathname: string }) {
  const [open, setOpen] = React.useState(false)
  const [coords, setCoords] = React.useState({ top: 0, left: 0 })
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const isActive = pathname.startsWith('/admin')

  const reposition = React.useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    // Centering needs the panel's own rendered width, not `left` + `transform:
    // translateX(-50%)` — the panel's `animate-fade-in-up` class runs a CSS
    // animation on the `transform` property itself, which overrides any
    // static inline transform value for the entire lifetime of the element
    // (fill-mode `both`), silently discarding a positioning translate.
    const panelWidth = panelRef.current?.getBoundingClientRect().width ?? 190
    setCoords({ top: rect.bottom + 8, left: rect.left + rect.width / 2 - panelWidth / 2 })
  }, [])

  React.useEffect(() => {
    if (!open) return
    reposition()
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
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

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Admin"
      data-active={isActive || undefined}
      className={`relative z-10 w-9 h-9 rounded-full flex items-center justify-center ${ICON_TRANSITION} ${
        isActive ? 'text-white' : 'text-bh-text-dim hover:text-bh-text'
      }`}
    >
      <Cog className="w-4 h-4" aria-hidden="true" />
    </button>
  )

  return (
    <>
      {open ? trigger : <Tooltip label="Admin">{trigger}</Tooltip>}
      {/* Rendered via portal + fixed positioning: a `position: absolute` panel
          here would be clipped by the topbar's own overflow-x-auto (mobile
          scroll fallback) — see interaction-design.md's dropdown-clipping note. */}
      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label="Admin"
          className="fixed min-w-[190px] bg-bh-surface border border-bh-border rounded-2xl shadow-lg p-1.5 animate-fade-in-up"
          style={{ zIndex: FLOATING_UI_Z, top: coords.top, left: coords.left }}
        >
          {ADMIN_NAV.map((n) => {
            const itemActive = pathname === n.to
            return (
              <Link
                key={n.to}
                to={n.to}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-colors duration-150 ${
                  itemActive
                    ? 'text-bh-accent bg-bh-accent-soft font-semibold'
                    : 'text-bh-text-muted hover:text-bh-text hover:bg-bh-bg-alt'
                }`}
              >
                <n.icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                {n.label}
              </Link>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [signingOut, setSigningOut] = React.useState(false)
  const [isAdmin, setIsAdmin] = React.useState(false)
  const pillRowRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    fetch('/api/admin/incidents', { credentials: 'include' })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false))
  }, [])

  const indicator = useSlidingIndicator(pillRowRef, [location.pathname, isAdmin])

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
      {/* Floating topbar — same shell as the landing page's: fixed,
          inset-x-stretched (not a content-hugging centered pill), same
          px-2 py-1.5 padding, same 3-zone `justify-between` layout
          (logo | sections | account). One link, one place — no second
          rail duplicating Home/Account. */}
      <header
        className="fixed top-4 inset-x-4 md:inset-x-6 lg:inset-x-10 z-40 flex items-center justify-between gap-1.5 bg-bh-surface border border-bh-border/60 rounded-full shadow-lg px-2 py-1.5 overflow-x-auto"
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

        {/* Primary sections + admin flyout share one sliding highlight. */}
        <div ref={pillRowRef} className="relative flex items-center gap-1.5">
          <SlidingIndicator rect={indicator} />
          {NAV.map((n) => (
            <NavPill
              key={n.to}
              to={n.to}
              icon={n.icon}
              label={n.label}
              active={n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)}
            />
          ))}
          {isAdmin && <AdminFlyout pathname={location.pathname} />}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <OrganizationSwitcher />
          <Tooltip label="Account">
            <Link
              to="/me"
              aria-label="Account"
              className={`relative w-9 h-9 rounded-full flex items-center justify-center ${ICON_TRANSITION} ${
                location.pathname === '/me'
                  ? 'bg-[#2b1812] text-white shadow-sm'
                  : 'text-bh-text-dim hover:text-bh-text hover:bg-bh-bg-alt'
              }`}
            >
              <CircleUser className="w-4 h-4" aria-hidden="true" />
            </Link>
          </Tooltip>
          <Tooltip label="Sign out">
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              aria-label="Sign out"
              className={`relative w-9 h-9 rounded-full flex items-center justify-center text-bh-text-dim hover:text-bh-danger hover:bg-bh-danger/10 disabled:opacity-50 ${ICON_TRANSITION}`}
            >
              {signingOut ? <span className="spinner" aria-hidden="true" /> : <LogOut className="w-4 h-4" aria-hidden="true" />}
            </button>
          </Tooltip>
        </div>
      </header>

      {/* Main */}
      <main id="main-content" className="pt-24 pb-8 px-4 lg:px-8">
        {children}
      </main>

      <BackToTop />
    </div>
  )
}
