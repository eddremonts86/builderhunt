import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { SourcesPage } from '~/modules/admin/sources/SourcesPage'

export const Route = createFileRoute('/_dashboard/admin/sources')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: SourcesPage,
})
