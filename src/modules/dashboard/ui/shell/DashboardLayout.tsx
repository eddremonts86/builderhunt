import * as React from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { motion, useReducedMotion } from 'motion/react'
import {
  LayoutDashboard, Search, Download, Mail, Compass,
} from 'lucide-react'
import { signOut } from '~/shared/lib/auth/client'
import { BackToTop } from '~/shared/components/BackToTop'
import { BrandLogoMark } from '~/shared/components/BrandLogoMark'
import { Tooltip } from '~/shared/components/Tooltip'
import { ICON_TRANSITION, useSlidingIndicator, SlidingIndicator } from '~/shared/lib/useSlidingIndicator'
import { OrganizationSwitcher } from '~/modules/dashboard/components/OrganizationSwitcher'
import { UserMenu } from '~/modules/dashboard/components/UserMenu'
import { ThemeToggle } from '~/modules/dashboard/components/ThemeToggle'
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

function NavPill({
  to, icon: Icon, label, active,
}: { to: string; icon: React.ComponentType<{ className?: string }>; label: string; active: boolean }) {
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
    </Link>
  )
}

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const reduceMotion = useReducedMotion()
  const [signingOut, setSigningOut] = React.useState(false)
  const [isAdmin, setIsAdmin] = React.useState(false)
  const pillRowRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    fetch('/api/admin/incidents', { credentials: 'include' })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false))
  }, [])

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

        <div ref={pillRowRef} className="relative flex items-center gap-1 rounded-full bg-bh-bg-alt/60 p-1">
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

      {/* Main */}
      <main id="main-content" className="pt-24 pb-8 px-4 lg:px-8">
        {children}
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
