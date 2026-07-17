import * as React from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  LayoutDashboard, Search, Download, Mail, CreditCard, Shield, Activity,
  Cog, Users, Inbox, AlertTriangle, BookOpen, Map, CircleUser, LogOut,
} from 'lucide-react'
import { signOut } from '~/shared/lib/auth/client'
import { BackToTop } from '~/shared/components/BackToTop'

function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-md shrink-0"
      style={{ width: size, height: size, background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
      aria-hidden="true"
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <path d="M5 4h7a4 4 0 0 1 4 4v1" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M16 4h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-7a4 4 0 0 0-4 4v3" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M8 20H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h7a4 4 0 0 0 4-4V7" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="11" cy="12" r="1.9" fill="#06b6d4" />
      </svg>
    </span>
  )
}

/** Primary sections — rendered as icon pills in the floating topbar. */
const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/search', icon: Search, label: 'Search', end: false },
  { to: '/exports', icon: Download, label: 'Exports', end: false },
  { to: '/alerts', icon: Mail, label: 'Alerts', end: false },
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

/** Local z-index scale for the floating shell (see layout.md — never arbitrary). */
const Z_NAV = 40
const Z_FLYOUT = 50

/** Shared hover/focus micro-lift for every icon-only trigger in the shell. */
const ICON_TRANSITION =
  'transition-[color,background-color,transform] duration-200 ease-out hover:scale-110 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100'

/**
 * Icon tooltip, portal + fixed-position — same reason as the admin flyout
 * panel: a `position: absolute` tooltip here would be clipped by the
 * topbar's own `overflow-x-auto` (CSS forces overflow-y to `auto` too the
 * moment overflow-x isn't `visible`, so there's no way to keep vertical
 * overflow visible on this element — see interaction-design.md).
 */
function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [coords, setCoords] = React.useState({ top: 0, left: 0 })
  const anchorRef = React.useRef<HTMLSpanElement>(null)

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setCoords({ top: rect.bottom + 8, left: rect.left + rect.width / 2 })
    setOpen(true)
  }
  const hide = () => setOpen(false)

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
        <span
          role="tooltip"
          aria-hidden="true"
          className="fixed pointer-events-none whitespace-nowrap rounded-md bg-bh-text px-2 py-1 text-[11px] font-medium text-white animate-fade-in motion-reduce:animate-none"
          style={{ top: coords.top, left: coords.left, transform: 'translateX(-50%)', zIndex: Z_FLYOUT }}
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  )
}

/**
 * Measures the currently-active pill (marked `data-active="true"`) inside
 * `containerRef` and returns coordinates for a shared sliding background,
 * so switching sections morphs the pill instead of snapping between icons.
 * Runs in a layout effect so it settles before paint — no flash on mount.
 */
function useSlidingIndicator(containerRef: React.RefObject<HTMLElement | null>, deps: React.DependencyList) {
  const [rect, setRect] = React.useState({ left: 0, width: 0, visible: false })

  React.useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const activeEl = container.querySelector<HTMLElement>('[data-active="true"]')
      if (!activeEl) {
        setRect((r) => ({ ...r, visible: false }))
        return
      }
      const cRect = container.getBoundingClientRect()
      const aRect = activeEl.getBoundingClientRect()
      setRect({ left: aRect.left - cRect.left + container.scrollLeft, width: aRect.width, visible: true })
    }
    measure()
    window.addEventListener('resize', measure)
    container.addEventListener('scroll', measure)
    return () => {
      window.removeEventListener('resize', measure)
      container.removeEventListener('scroll', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return rect
}

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
    setCoords({ top: rect.bottom + 8, left: rect.left + rect.width / 2 })
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
          style={{ zIndex: Z_FLYOUT, top: coords.top, left: coords.left, transform: 'translateX(-50%)' }}
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
      {/* Floating topbar — the single source for every dashboard nav link.
          (There used to be a second floating rail duplicating Home/Account —
          removed. One link, one place.) */}
      <header
        className="fixed top-4 inset-x-4 lg:left-1/2 lg:right-auto lg:-translate-x-1/2 flex items-center gap-1.5 bg-bh-surface border border-bh-border/60 rounded-full shadow-lg px-2 py-1.5 overflow-x-auto max-w-[calc(100vw-2rem)]"
        style={{ zIndex: Z_NAV }}
        aria-label="Main navigation"
      >
        <Tooltip label="Back to home">
          <Link
            to="/"
            aria-label="BuilderHunt home"
            className={`relative flex items-center px-1.5 ${ICON_TRANSITION}`}
          >
            <LogoMark />
          </Link>
        </Tooltip>

        <span className="w-px h-5 bg-bh-border shrink-0 mx-0.5" aria-hidden="true" />

        {/* Primary sections + admin flyout share one sliding highlight. */}
        <div ref={pillRowRef} className="relative flex items-center gap-1.5">
          <span
            className="absolute inset-y-0 rounded-full bg-[#2b1812] shadow-sm transition-[left,width,opacity] duration-300 ease-out motion-reduce:transition-none"
            style={{ left: indicator.left, width: indicator.width, opacity: indicator.visible ? 1 : 0 }}
            aria-hidden="true"
          />
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

        <span className="w-px h-5 bg-bh-border shrink-0 mx-0.5" aria-hidden="true" />

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
      </header>

      {/* Main */}
      <main id="main-content" className="pt-24 pb-8 px-4 lg:px-8">
        {children}
      </main>

      <BackToTop />
    </div>
  )
}
