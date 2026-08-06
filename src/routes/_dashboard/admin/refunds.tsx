import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { RefundQueue } from '~/modules/admin/billing/RefundQueue'

export const Route = createFileRoute('/_dashboard/admin/refunds')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: RefundQueue,
})
