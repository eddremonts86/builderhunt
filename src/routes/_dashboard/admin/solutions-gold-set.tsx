import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { GoldSetPage } from '~/modules/admin/solutions/GoldSetPage'

export const Route = createFileRoute('/_dashboard/admin/solutions-gold-set')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: GoldSetPage,
})
