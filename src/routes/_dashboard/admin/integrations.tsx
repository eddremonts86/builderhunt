import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { IntegrationsPage } from '~/modules/admin/integrations/IntegrationsPage'

export const Route = createFileRoute('/_dashboard/admin/integrations')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: IntegrationsPage,
})
