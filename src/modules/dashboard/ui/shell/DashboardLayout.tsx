import * as React from 'react'
import { Outlet, Link, useNavigate } from '@tanstack/react-router'
import {
  LayoutDashboard, Search, Users, Download, GitBranch,
} from 'lucide-react'
import { signOut } from '~/shared/lib/auth/client'

export function DashboardLayout() {
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = React.useState(false)

  const handleSignOut = async () => {
    setSigningOut(true)
    await signOut()
    navigate({ to: '/auth/sign-in' })
  }

  return (
    <div className="flex h-screen bg-bh-bg">
      {/* Sidebar */}
      <aside className="w-64 border-r border-bh-border flex flex-col">
        {/* Logo */}
        <div className="px-6 py-5 border-b border-bh-border">
          <Link to="/_dashboard/dashboard/" className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-bh-accent" />
            <span className="text-bh-text font-semibold text-lg">BuilderHunt</span>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {[
            { to: '/_dashboard/dashboard/', icon: LayoutDashboard, label: 'Dashboard' },
            { to: '/_dashboard/search/', icon: Search, label: 'Search' },
            { to: '/_dashboard/exports/', icon: Download, label: 'Exports' },
          ].map(({ to, icon: Icon, label }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/5 transition-colors text-sm"
              activeClassName="!text-bh-accent !bg-bh-accent/10"
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-bh-border">
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-bh-text-muted hover:text-bh-text hover:bg-white/5 transition-colors text-sm"
          >
            <Users className="w-4 h-4" />
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}