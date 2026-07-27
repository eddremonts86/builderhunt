import * as React from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { signOut } from '~/shared/lib/auth/client'
import { BackToTop } from '~/shared/components/BackToTop'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'
import { AreaPanel } from './AreaPanel'
import { AreaRail } from './AreaRail'
import { ContextTopbar } from './ContextTopbar'
import { MobileNavDrawer } from './MobileNavDrawer'
import { breadcrumbFor, resolveActiveArea, visibleAreas } from './nav-config'

/**
 * Shell C — a 60px area rail, a 212px panel for the active area, and a
 * contextual topbar.
 *
 * Replaces the floating topbar pill, which held 7 destinations and hid the
 * other 16 behind an avatar dropdown. Navigation now comes entirely from
 * `nav-config.ts`; this file only composes the three regions.
 *
 * Width note: the old layout sized its content with `.container`, whose
 * `--page-max` also sizes the landing header so the two lined up. With a
 * sidebar that alignment is no longer possible, so the dashboard's content is
 * deliberately fluid inside the remaining space with a max of its own — see
 * `.dashboard-canvas` in globals.css.
 */
function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [signingOut, setSigningOut] = React.useState(false)
  const [isAdmin, setIsAdmin] = React.useState(false)
  const [navOpen, setNavOpen] = React.useState(false)
  const [unreadAlertsCount, setUnreadAlertsCount] = React.useState(0)
  const [planRequestsCount, setPlanRequestsCount] = React.useState(0)

  React.useEffect(() => {
    fetch('/api/admin/incidents', { credentials: 'include' })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false))
  }, [])

  React.useEffect(() => {
    // Signing out navigates away while this layout is still mounted, so the
    // pathname change fires this effect one last time — just after the session
    // was revoked. That request could only ever come back 401, and Chromium
    // logs every one of them, so every sign-out left a console error behind.
    // `signingOut` flips before `signOut()` is awaited, which is early enough.
    if (signingOut) return
    fetch('/api/alerts/triggers/unread-count', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { count: 0 }))
      .then((data) => setUnreadAlertsCount(data.count ?? 0))
      .catch(() => setUnreadAlertsCount(0))
  }, [location.pathname, signingOut])

  // Admin-only counter, so it is never requested for tenant users — an
  // unconditional fetch would 403 on every navigation for most of the userbase.
  React.useEffect(() => {
    if (!isAdmin) {
      setPlanRequestsCount(0)
      return
    }
    // GET /api/admin/plan-requests takes no filters — it returns the latest 200
    // rows of every status — so "needs attention" is counted here rather than
    // badging the endpoint's raw length, which would never reach zero.
    fetch('/api/admin/plan-requests', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        const pending = Array.isArray(rows)
          ? rows.filter((row) => (row as { status?: string }).status === 'pending').length
          : 0
        setPlanRequestsCount(pending)
      })
      .catch(() => setPlanRequestsCount(0))
  }, [isAdmin, location.pathname])

  const areas = visibleAreas(isAdmin)
  const activeArea = resolveActiveArea(location.pathname, isAdmin)
  const crumbs = breadcrumbFor(location.pathname, isAdmin)
  const badges = React.useMemo(
    () => ({ unreadAlerts: unreadAlertsCount, planRequests: planRequestsCount }),
    [unreadAlertsCount, planRequestsCount],
  )

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      navigate({ to: '/auth/sign-in' })
    }
  }

  return (
    <div className="min-h-[100dvh] bg-app lg:grid lg:grid-cols-[60px_212px_minmax(0,1fr)]">
      {/* Both nav columns are desktop-only; below `lg` they become one drawer. */}
      <div className="hidden lg:sticky lg:top-0 lg:flex lg:h-[100dvh] lg:flex-col">
        <AreaRail areas={areas} activeAreaId={activeArea.id} badges={badges} />
      </div>
      <AreaPanel
        area={activeArea}
        pathname={location.pathname}
        badges={badges}
        className="hidden lg:sticky lg:top-0 lg:flex lg:h-[100dvh] border-r border-bh-border"
      />

      <MobileNavDrawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        areas={areas}
        activeAreaId={activeArea.id}
        pathname={location.pathname}
        badges={badges}
      />

      <div className="flex min-h-[100dvh] min-w-0 flex-col">
        <ContextTopbar
          crumbs={crumbs}
          signingOut={signingOut}
          onSignOut={handleSignOut}
          pathname={location.pathname}
          onOpenNav={() => setNavOpen(true)}
        />
        <main className="dashboard-canvas flex-1 px-4 pb-10 pt-6 lg:px-6">
          {children}
        </main>
      </div>

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
