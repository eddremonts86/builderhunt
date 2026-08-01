import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { AdminUsersPage } from '~/modules/admin/users/AdminUsersPage'

export const Route = createFileRoute('/_dashboard/admin/users')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminUsersPage,
})
