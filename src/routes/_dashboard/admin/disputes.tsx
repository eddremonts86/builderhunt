import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { DisputeQueue } from '~/modules/admin/billing/DisputeQueue'

export const Route = createFileRoute('/_dashboard/admin/disputes')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: DisputeQueue,
})
