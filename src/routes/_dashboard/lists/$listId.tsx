/**
 * /dashboard/lists/$listId — shortlist detail. Client-side fetch on
 * mount; the `beforeLoad` only verifies the user has an active
 * organization. The API at `/api/lists/:id` and
 * `/api/lists/:id/items` is the source of truth for visibility and
 * removal authorization, so a peek-by-id of a list from a different
 * organization returns 404 and the page surfaces "List not found."
 */
import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import {
  ListDetailPage,
  type BuilderListDetail,
} from '~/modules/dashboard/components/ListDetailPage'

interface ListDetailBeforeLoadContext {
  userId: string
  role: 'owner' | 'admin' | 'member'
}

export const Route = createFileRoute('/_dashboard/lists/$listId')({
  beforeLoad: async (): Promise<ListDetailBeforeLoadContext> => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!user.activeOrganizationId) throw new Error('No active organization')
    return { userId: user.userId, role: 'member' }
  },
  component: ListDetailRoute,
})

function ListDetailRoute() {
  const { userId, role } = Route.useRouteContext() as unknown as ListDetailBeforeLoadContext
  // Both fetches happen client-side inside ListDetailPage so an
  // A→B organization switch with in-flight responses is cancelled
  // (the page re-loads on remount when the route param changes).
  const initialList: BuilderListDetail = {
    id: '',
    organizationId: '',
    createdByUserId: '',
    name: '',
    description: null,
    visibility: 'private',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  return (
    <ListDetailPage
      initialList={initialList}
      initialItems={[]}
      currentUser={{ userId, role }}
    />
  )
}
