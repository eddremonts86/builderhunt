import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listRecentOrganizationBuilders } from '~/shared/lib/repositories/organization-builders'

export const Route = createFileRoute('/api/builders/recent/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rows = await withTenantContext(principal, (tx) =>
            listRecentOrganizationBuilders(tx, principal.organizationId),
          )
          return Response.json(rows.map((row) => ({
            id: row.id,
            username: row.username,
            displayName: row.displayName,
            source: row.source,
            bio: row.bio,
            followersCount: row.followersCount,
            topics: privateTopics(row.privateMetadata),
            lastSeen: row.lastSeen,
          })))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Recent builders error:', error)
          return Response.json({ error: 'Failed to fetch recent builders' }, { status: 500 })
        }
      },
    },
  },
})

function privateTopics(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.topics)
    ? metadata.topics.filter((value): value is string => typeof value === 'string')
    : []
}
