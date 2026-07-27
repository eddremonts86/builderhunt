import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { ChangelogManager } from '~/modules/admin/content/ChangelogManager'

// Kept as its own route (the nav, the regression suite and existing bookmarks
// all point at /admin/changelog) while the implementation lives in the module
// that /admin/content?tab=changelog also renders.
export const Route = createFileRoute('/_dashboard/admin/changelog')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: ChangelogManager,
})
