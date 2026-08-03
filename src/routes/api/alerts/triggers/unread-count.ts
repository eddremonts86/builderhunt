import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { unreadOrganizationTriggerCount } from '~/shared/lib/repositories/organization-alerts'

export const Route = createFileRoute('/api/alerts/triggers/unread-count')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const count = await withTenantContext(principal, (tx) =>
            unreadOrganizationTriggerCount(tx, principal.organizationId),
          )
          return Response.json({ count })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('alerts/triggers/unread-count error:', error)
          return Response.json({ error: 'Failed to fetch unread count' }, { status: 500 })
        }
      },
    },
  },
})
