import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listOrganizationBuilders } from '~/shared/lib/repositories/organization-builders'

export const Route = createFileRoute('/api/me/builders/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rows = await withTenantContext(principal, (tx) =>
            listOrganizationBuilders(tx, principal.organizationId),
          )
          return Response.json(rows.map((builder) => ({
            id: builder.id,
            identityId: builder.identityId,
            username: builder.username,
            displayName: builder.displayName,
            avatarUrl: builder.avatarUrl,
            source: builder.source,
            profileUrl: builder.profileUrl,
            topics: readStringArray(builder.privateMetadata.topics),
            score: typeof builder.privateMetadata.score === 'number' ? builder.privateMetadata.score : null,
            lastSeen: builder.lastSeen,
          })))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('List tracked builders error:', error)
          return Response.json({ error: 'Failed to fetch tracked builders' }, { status: 500 })
        }
      },
    },
  },
})

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
