// Plan 29 (activity-feed) task 5 — /dashboard/team/activity.
//
// The page is a thin client-side fetch on top of the
// /api/organizations/activity endpoint. SSR is intentionally
// minimal: the page is a client component that asks for the
// first page on mount. The keyset cursor and the AbortController
// in TeamActivityPage handle in-flight cancellation across
// org switches (the spec demands no feed while the context is
// switching/stale).

import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import {
  TeamActivityPage,
} from '~/modules/dashboard/components/TeamActivityPage'
import type { ActivityRowDTO } from '~/modules/dashboard/components/TeamActivityWidget'

interface ActivityBeforeLoadContext {
  userId: string
}

export const Route = createFileRoute('/_dashboard/team/activity')({
  beforeLoad: async (): Promise<ActivityBeforeLoadContext> => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!user.activeOrganizationId) throw new Error('No active organization')
    return { userId: user.userId }
  },
  component: TeamActivityRoute,
})

function TeamActivityRoute() {
  // Both fetches happen client-side inside the page so an
  // A→B organization switch with in-flight responses is
  // cancelled by the AbortController. The empty initial state
  // is replaced on the first successful load.
  return (
    <TeamActivityPage
      initialRows={[] as ActivityRowDTO[]}
      initialCursor={null}
    />
  )
}
