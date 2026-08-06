import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { DisputeQueue } from '~/modules/admin/billing/DisputeQueue'

export const Route = createFileRoute('/_dashboard/admin/disputes')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: DisputeQueue,
})
