import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { AccessRequestsPage } from '~/modules/admin/access-requests/AccessRequestsPage'

/**
 * Where invite-only sign-up is administered (waitlist-launch plan).
 *
 * The `beforeLoad` guard mirrors every other admin route: it keeps a non-admin from *rendering* the
 * page. It is not the security boundary — `/api/admin/access-requests` re-checks the principal on
 * every call, and the database refuses an UPDATE from any role but `builderhunt_platform`. Three
 * layers, because the middle one is the only one an attacker cannot skip by calling the API directly.
 */
export const Route = createFileRoute('/_dashboard/admin/access-requests')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AccessRequestsPage,
})
