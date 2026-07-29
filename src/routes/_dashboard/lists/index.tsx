/**
 * /dashboard/lists — shortlists index. Client-side fetch on mount;
 * the `beforeLoad` only enforces that the user is authenticated and
 * has an active organization. Org switching is handled inside
 * `ListsPage` via the initialLists-length heuristic.
 *
 * Mirrors the auth pattern in `/dashboard/alerts` — the real org
 * membership gate is the principal-scoped API at `/api/lists`,
 * which returns 403 for a session whose active organization does
 * not include the user, and 404 for any cross-tenant id probe.
 */
import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { ListsPage, type BuilderList } from '~/modules/dashboard/components/ListsPage'

interface ListIndexBeforeLoadContext {
  userId: string
  role: 'owner' | 'admin' | 'member'
}

export const Route = createFileRoute('/_dashboard/lists/')({
  beforeLoad: async (): Promise<ListIndexBeforeLoadContext> => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!user.activeOrganizationId) throw new Error('No active organization')
    // Role for the page is informational; the principal-scoped API at
    // /api/lists is the source of truth for what the caller can do.
    // Default to 'member' — the API rejects anything stronger a
    // caller tries to do.
    return { userId: user.userId, role: 'member' }
  },
  component: ListsIndexRoute,
})

function ListsIndexRoute() {
  const { userId, role } = Route.useRouteContext() as unknown as ListIndexBeforeLoadContext
  return <ListsPage initialLists={[]} currentUser={{ userId, role }} />
}
