import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { GoldSetPage } from '~/modules/admin/solutions/GoldSetPage'

export const Route = createFileRoute('/_dashboard/admin/solutions-gold-set')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: GoldSetPage,
})
