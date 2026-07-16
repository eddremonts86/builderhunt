import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  LayoutDashboard, Search, Users, Download, GitBranch, LogOut, Bell, Settings,
  AlertTriangle, BookOpen, Map, Activity, Shield, Inbox, CreditCard,
} from 'lucide-react'
import { signOut } from '~/shared/lib/auth/client'

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

const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/search', icon: Search, label: 'Search' },
  { to: '/exports', icon: Download, label: 'Exports' },
] as const

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = React.useState(false)
  const [isAdmin, setIsAdmin] = React.useState(false)

  React.useEffect(() => {
    // Check admin status via the me endpoint or a known admin status
    const adminIds = ((typeof window !== 'undefined' && (window as { __ADMIN_IDS__?: string }).__ADMIN_IDS__) || '').split(',').filter(Boolean)
    // We can't read env vars in the client, so rely on a fetch
    fetch('/api/admin/incidents', { credentials: 'include' })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false))
  }, [])

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      navigate({ to: '/auth/sign-in' })
    }
  }

  return (
    <div className="flex h-screen bg-app">
      {/* Sidebar */}
      <aside
        className="w-60 shrink-0 border-r border-bh-border flex flex-col bg-bh-bg-alt/40"
        aria-label="Main navigation"
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b border-bh-border">
          <Link to="/" className="flex items-center gap-2.5" aria-label="BuilderHunt home">
            <LogoMark />
            <span className="font-bold text-base tracking-tight">BuilderHunt</span>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4">
          <ul className="space-y-1">
            {NAV.map((n) => (
              <li key={n.to}>
                <Link
                  to={n.to}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm font-medium"
                  activeProps={{
                    className:
                      'flex items-center gap-3 px-3 py-2 rounded-lg text-bh-accent bg-bh-accent/10 text-sm font-semibold',
                  }}
                >
                  <n.icon className="w-4 h-4" aria-hidden="true" />
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Footer / account */}
        <div className="px-3 py-4 border-t border-bh-border space-y-1">
          <Link
            to="/exports"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
          >
            <Settings className="w-4 h-4" aria-hidden="true" />
            Settings
          </Link>
          <Link
            to="/settings/privacy"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
            data-testid="nav-privacy"
          >
            <Shield className="w-4 h-4" aria-hidden="true" />
            Privacy &amp; data
          </Link>
          <Link
            to="/settings/billing"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
            data-testid="nav-billing"
          >
            <CreditCard className="w-4 h-4" aria-hidden="true" />
            Billing
          </Link>
          {isAdmin && (
            <>
              <div className="pt-2 pb-1 px-3 text-[10px] uppercase tracking-wider text-bh-text-dim font-semibold">
                Admin
              </div>
              <Link
                to="/admin/metrics"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
                data-testid="admin-nav-metrics"
              >
                <Activity className="w-4 h-4" aria-hidden="true" />
                Metrics
              </Link>
              <Link
                to="/admin/users"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
                data-testid="admin-nav-users"
              >
                <Users className="w-4 h-4" aria-hidden="true" />
                Users
              </Link>
              <Link
                to="/admin/plan-requests"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
                data-testid="admin-nav-plan-requests"
              >
                <Inbox className="w-4 h-4" aria-hidden="true" />
                Plan requests
              </Link>
              <Link
                to="/admin/incidents"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
                data-testid="admin-nav-incidents"
              >
                <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                Incidents
              </Link>
              <Link
                to="/admin/changelog"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
                data-testid="admin-nav-changelog"
              >
                <BookOpen className="w-4 h-4" aria-hidden="true" />
                Changelog
              </Link>
              <Link
                to="/admin/roadmap"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
                data-testid="admin-nav-roadmap"
              >
                <Map className="w-4 h-4" aria-hidden="true" />
                Roadmap
              </Link>
            </>
          )}
          <Link
            to="/status"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
            data-testid="nav-status"
          >
            <Activity className="w-4 h-4 text-bh-success" aria-hidden="true" />
            Status
          </Link>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/[0.04] transition-colors text-sm"
          >
            {signingOut ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Signing out...
              </>
            ) : (
              <>
                <LogOut className="w-4 h-4" aria-hidden="true" />
                Sign out
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main id="main-content" className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}
