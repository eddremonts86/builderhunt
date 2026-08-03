import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'

export const Route = createFileRoute('/api/organizations/deletion')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['DELETE']),

      // Cancels a pending deletion request for the caller's own active
      // organization — never a client-chosen one. Owner-only, but (unlike
      // requesting deletion) doesn't require recent authentication, since
      // cancelling is the safe direction.
      DELETE: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const lifecycle = await getOrganizationLifecycle()
          const result = await lifecycle.cancelOrganizationDeletion(request, principal.organizationId)
          return Response.json({ ok: true, id: result.id })
        } catch (error) {
          if (error instanceof OrganizationLifecycleError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Organization deletion cancel error:', error)
          return Response.json({ error: 'Failed to cancel deletion' }, { status: 500 })
        }
      },
    },
  },
})
