import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { markOrganizationTriggerRead } from '~/shared/lib/repositories/organization-alerts'

export const Route = createFileRoute('/api/alerts/triggers/$id')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH']),

      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const ok = await withTenantContext(principal, (tx) =>
            markOrganizationTriggerRead(tx, principal.organizationId, params.id),
          )
          return Response.json({ ok })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('trigger read error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
