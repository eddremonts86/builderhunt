import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { RefundQueue } from '~/modules/admin/billing/RefundQueue'

export const Route = createFileRoute('/_dashboard/admin/refunds')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: RefundQueue,
})
