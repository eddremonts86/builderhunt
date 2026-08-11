import * as React from 'react'
import { useLocation, useNavigate, useMatch } from '@tanstack/react-router'
import { signOut } from '~/shared/lib/auth/client'
import { BackToTop } from '~/shared/components/BackToTop'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'
import { AreaPanel } from './AreaPanel'
import { AreaRail } from './AreaRail'
import { BreadcrumbProvider, useCurrentEntityBreadcrumbLabel } from './breadcrumb-context'
import { resolveBreadcrumbSegments } from './breadcrumbs'
import { ContextTopbar } from './ContextTopbar'
import { ServiceDegradationNotice } from './ServiceDegradationNotice'
import { MobileNavDrawer } from './MobileNavDrawer'
import { resolveActiveArea, visibleAreas } from './nav-config'

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
  // Read admin flag from the `_dashboard` route context, but tolerate this
  // layout being mounted outside that subtree (the public `/status` page
  // reuses the dashboard shell for signed-in visitors so the org-switcher
  // stays available). `useMatch` does not throw on a missing match; it
  // returns `undefined`. We always call the hook (Rules of Hooks require a
  // stable order), then narrow.
  //
  // `select` rather than a cast on the match. `useRouteContext` returned the
  // context itself, so the switch to `useMatch` — which returns the *match*,
  // with the context under `.context` — left this reading `match.user`, one
  // level too high. `as` asserted the shape instead of checking it and `?.`
  // turned the miss into `undefined`, so `isAdmin` was false for every admin
  // and the admin area vanished from the rail. The pages themselves kept
  // working, because each one guards itself with its own `beforeLoad` call —
  // which is exactly why nothing failed loudly.
  const isAdmin = useMatch({
    from: '/_dashboard',
    shouldThrow: false,
    select: (m) => (m.context as { user?: { isPlatformAdmin?: boolean } } | undefined)?.user?.isPlatformAdmin ?? false,
  }) ?? false
  // `isPlatformAdmin` is computed server-side in `beforeLoad` (see
  // `getAppAuthSession` in auth-session.ts) and surfaced via route context.
  // The previous version polled `/api/admin/incidents` from a `useEffect` to
  // decide whether to render the admin nav — every non-admin hit logged a
  // noisy 403 in the console and on the network panel (saas-review F6).
  const [signingOut, setSigningOut] = React.useState(false)
  const [navOpen, setNavOpen] = React.useState(false)

  /**
   * Beta mode, read once per shell mount (plan 58).
   *
   * `/api/beta-mode` returns `{ enabled, revision }` off a five-second cache, so this costs one cheap
   * request for the whole session rather than one per page — which is what a `useEffect` inside
   * `UserMenu` would have cost, since that component mounts on every dashboard route.
   *
   * A failure leaves the badge absent. It is a label; it must never be able to break the shell that
   * carries the navigation.
   */
  const [betaModeEnabled, setBetaModeEnabled] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/beta-mode', { credentials: 'include' })
        if (!response.ok || cancelled) return
        const body = await response.json() as { enabled?: unknown }
        if (!cancelled) setBetaModeEnabled(body.enabled === true)
      } catch {
        // Deliberately silent: no badge is the correct outcome, and a console error here would fail the
        // strict browser collectors on every dashboard spec.
      }
    })()
    return () => { cancelled = true }
  }, [])
  const [unreadAlertsCount, setUnreadAlertsCount] = React.useState(0)

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

  const entityLabel = useCurrentEntityBreadcrumbLabel()
  const areas = visibleAreas(isAdmin)
  const activeArea = resolveActiveArea(location.pathname, isAdmin)
  const crumbs = resolveBreadcrumbSegments(location.pathname, isAdmin, entityLabel)
  const badges = React.useMemo(
    () => ({ unreadAlerts: unreadAlertsCount }),
    [unreadAlertsCount],
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
          betaModeEnabled={betaModeEnabled}
          crumbs={crumbs}
          signingOut={signingOut}
          onSignOut={handleSignOut}
          pathname={location.pathname}
          onOpenNav={() => setNavOpen(true)}
        />
        <main className="dashboard-canvas flex-1 px-4 pb-10 pt-6 lg:px-6">
          {/*
            Above the page's own content, and absent when nothing is degraded.

            Inside `<main>` rather than in the topbar because it is about the work on this page — "things may be
            slow or fail to save" — and a topbar banner reads as chrome that has always been there. There is no
            permanent widget: healthy renders nothing at all, which is what makes it worth reading when it appears.
          */}
          <ServiceDegradationNotice />
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
      <BreadcrumbProvider>
        <DashboardLayoutInner>{children}</DashboardLayoutInner>
      </BreadcrumbProvider>
    </ThemeProvider>
  )
}
