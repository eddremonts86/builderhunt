import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listRecentOrganizationBuilders } from '~/shared/lib/repositories/organization-builders'
import { filterSuppressed } from '~/shared/lib/profile-suppression'

export const Route = createFileRoute('/api/builders/recent/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rows = await withTenantContext(principal, (tx) =>
            listRecentOrganizationBuilders(tx, principal.organizationId),
          )
          const visible = await filterSuppressed(rows)
          return Response.json(visible.map((row) => ({
            id: row.id,
            // The profile page route (/builder/$builderId, /builders/$builderId)
            // and GET /api/builders/:id both key on the global builder_identities
            // id, not organization_builders.id — expose it separately so links
            // built from this list resolve instead of 404ing.
            identityId: row.identityId,
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
