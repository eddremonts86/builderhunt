import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

export const Route = createFileRoute('/_dashboard')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in' })
    }
    return { user }
  },
  component: () => <Outlet />,
})