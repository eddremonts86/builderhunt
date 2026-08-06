import { useQuery } from '@tanstack/react-query'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import type { OrganizationRole } from '~/shared/lib/authorization/permissions'

/**
 * The caller's role in the active organization, for widget eligibility.
 *
 * ## This is a *rendering* decision, never an authorization one
 *
 * `orderedWidgets` uses it to decide what to draw. Nothing here keeps a member from seeing owner
 * data — the projection simply does not send it: `/api/dashboard/overview` omits the `usage` key
 * entirely for a role that may not read billing. If this hook were wrong in the permissive
 * direction, the worst outcome is a widget that renders `forbidden`, which renders nothing.
 *
 * Stating that plainly matters, because a role in the browser looks like an access control and a
 * later reader could be tempted to lean on it as one.
 *
 * ## The same query key as `OrganizationSwitcher`
 *
 * Deliberately, so React Query serves both from one request. A second endpoint just to learn the
 * viewer's own role would be a second thing to keep in step with membership changes, and this one
 * already invalidates on an organization switch.
 *
 * Defaults to `member` while loading and on failure — the narrowest role, so a slow response cannot
 * flash an owner-only widget at someone who is not one.
 */
export function useViewerRole(): OrganizationRole {
  const activeOrganizationId = useActiveOrganizationId()

  const { data } = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'my-organizations'),
    queryFn: async (): Promise<Array<{ id: string; role: OrganizationRole }>> => {
      const response = await fetch('/api/organizations', { credentials: 'include' })
      if (!response.ok) throw new Error('Failed to load organizations')
      return response.json()
    },
  })

  const active = data?.find((organization) => organization.id === activeOrganizationId)
  return active?.role ?? 'member'
}
