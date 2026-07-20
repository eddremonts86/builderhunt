import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router'
import { Header } from '~/shared/components/Header'
import { Footer } from '~/shared/components/Footer'
import { BackToTop } from '~/shared/components/BackToTop'
import { useSession } from '~/shared/lib/auth/client'

export const Route = createFileRoute('/_landing')({
  component: LandingLayout,
})

function LandingLayout() {
  const location = useLocation()
  const session = useSession()
  const isAuthed = !!session.data?.user

  // If the user is logged in, /status and /explore wrap themselves in DashboardLayout
  // to show the application dashboard interface, so we skip the landing layout wrapper
  const skipLandingLayout = isAuthed && (location.pathname === '/status' || location.pathname.startsWith('/explore'))

  if (skipLandingLayout) {
    return <Outlet />
  }

  return (
    <div className="flex flex-col min-h-screen bg-app">
      <Header />
      <main className={`flex-grow ${location.pathname === '/' ? '' : 'pt-20'}`}>
        <Outlet />
      </main>
      <Footer />
      <BackToTop />
    </div>
  )
}
