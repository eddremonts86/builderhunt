import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { RoadmapManager } from '~/modules/admin/content/RoadmapManager'

// See the note in ./changelog.tsx — same split: route stays, implementation is
// shared with /admin/content?tab=roadmap.
export const Route = createFileRoute('/_dashboard/admin/roadmap')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: RoadmapManager,
})
