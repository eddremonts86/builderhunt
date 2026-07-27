import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { RoadmapManager } from '~/modules/admin/content/RoadmapManager'

// See the note in ./changelog.tsx — same split: route stays, implementation is
// shared with /admin/content?tab=roadmap.
export const Route = createFileRoute('/_dashboard/admin/roadmap')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: RoadmapManager,
})
