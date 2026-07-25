import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { AbuseWarningBanner } from '~/modules/dashboard/components/AbuseWarningBanner'
import { DashboardLayout } from '~/modules/dashboard/ui/shell/DashboardLayout'
import { TenantQueryProvider } from '~/shared/components/TenantQueryProvider'

export const Route = createFileRoute('/_dashboard')({
  beforeLoad: async ({ location }) => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      // Preserve the deep link (path + search) so sign-in can return the
      // user here — SignInPage only honors same-origin "/" paths.
      throw redirect({ to: '/auth/sign-in', search: { redirect: location.href } })
    }
    return { user }
  },
  component: DashboardRoute,
})

function DashboardRoute() {
  const { user } = Route.useRouteContext()
  return (
    <TenantQueryProvider activeOrganizationId={user.activeOrganizationId}>
      <DashboardLayout>
        <AbuseWarningBanner />
        <Outlet />
      </DashboardLayout>
    </TenantQueryProvider>
  )
}