import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { ClaimsPage } from '~/modules/admin/claims/ClaimsPage'

export const Route = createFileRoute('/_dashboard/admin/claims')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: ClaimsPage,
})
