import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getOrganizationDashboardStats } from '~/shared/lib/repositories/organization-builders'

export const Route = createFileRoute('/api/dashboard/stats')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          const stats = await withTenantContext(principal, (tx) =>
            getOrganizationDashboardStats(tx, principal.organizationId, weekAgo),
          )
          return Response.json(stats)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Dashboard stats error:', error)
          return Response.json({ error: 'Failed to fetch stats' }, { status: 500 })
        }
      },
    },
  },
})
