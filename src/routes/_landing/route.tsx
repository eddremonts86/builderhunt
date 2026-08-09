import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router'
import { Header } from '~/shared/components/Header'
import { Footer } from '~/shared/components/Footer'
import { BackToTop } from '~/shared/components/BackToTop'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'

/**
 * The session is resolved on the server, exactly as `_dashboard` does it.
 *
 * `useSession()` is a client hook: during SSR it has no session, so the server rendered the
 * signed-out tree for a signed-in visitor, and the client's first render could already have the
 * session. React calls that a hydration mismatch (minified #418) and regenerates the tree — which
 * is both a visible flash of "Sign in / Get started" for someone already signed in, and an
 * uncaught page error that the e2e strict guard is right to fail on. It cost two intermittent CI
 * failures on `E2E (shard 4/4)`, and the spec had to carry a budget of one-shot allowances sized to
 * the number of page loads to stay green at all.
 *
 * Five components in this tree read the session that way, and the worst of them is not the header:
 * `skipLandingLayout` below chooses between the whole landing chrome and a bare `<Outlet />`, and
 * `status.tsx` chooses between two entirely different trees. On `/status` and `/explore` a signed-in
 * visitor could therefore have the server and the client disagree about the whole page, not a button.
 *
 * `beforeLoad` runs on the server for a full page load and on the client only for SPA navigation
 * (see the docblock on `getIsAppAdmin`), so the server render and the first client render start from
 * the same answer. This is not an extra round trip either: it replaces `useSession`'s own
 * `/api/auth/get-session` fetch, and on a full page load it costs none at all.
 */
export const Route = createFileRoute('/_landing')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    return { user }
  },
  component: LandingLayout,
})

function LandingLayout() {
  const location = useLocation()
  const { user } = Route.useRouteContext()
  const isAuthed = !!user.userId

  // If the user is logged in, /status and /explore wrap themselves in DashboardLayout
  // to show the application dashboard interface, so we skip the landing layout wrapper
  // (DashboardLayout mounts its own ThemeProvider, so theme still applies there).
  const skipLandingLayout = isAuthed && (location.pathname === '/status' || location.pathname.startsWith('/explore'))

  if (skipLandingLayout) {
    return <Outlet />
  }

  return (
    <ThemeProvider>
      <div className="flex flex-col min-h-screen bg-app">
        <Header isAuthed={isAuthed} />
        <main className={`flex-grow ${location.pathname === '/' ? '' : 'pt-20'}`}>
          <Outlet />
        </main>
        <Footer />
        <BackToTop />
      </div>
    </ThemeProvider>
  )
}
