import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { DashboardLayout } from '~/modules/dashboard/ui/shell/DashboardLayout'
import { TenantQueryProvider } from '~/shared/components/TenantQueryProvider'

export const Route = createFileRoute('/_dashboard')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in' })
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
        <Outlet />
      </DashboardLayout>
    </TenantQueryProvider>
  )
}