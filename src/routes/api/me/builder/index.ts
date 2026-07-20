import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listVerifiedBuilderProfiles } from '~/shared/lib/repositories/builder-claims'

export const Route = createFileRoute('/api/me/builder/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rows = await withTenantContext(principal, (tx) =>
            listVerifiedBuilderProfiles(tx, principal.userId),
          )
          return Response.json(rows)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Get me/builder error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
