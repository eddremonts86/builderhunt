import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { AbuseConsole } from '~/modules/dashboard/components/AbuseConsole'

export const Route = createFileRoute('/_dashboard/admin/abuse')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: AbuseConsole,
})
