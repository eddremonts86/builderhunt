import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { AdminUsersPage } from '~/modules/admin/users/AdminUsersPage'

export const Route = createFileRoute('/_dashboard/admin/users')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: AdminUsersPage,
})
