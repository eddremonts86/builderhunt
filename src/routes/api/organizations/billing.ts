import { createFileRoute } from '@tanstack/react-router'
import { getOrganizationBillingSnapshot, requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/organizations/contracts'

export const Route = createFileRoute('/api/organizations/billing')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const snapshot = await getOrganizationBillingSnapshot(principal)
          if (!snapshot) return Response.json({ error: 'Organization not found' }, { status: 404 })
          return Response.json(snapshot)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Organization billing snapshot error:', error)
          return Response.json({ error: 'Failed to load billing' }, { status: 500 })
        }
      },
    },
  },
})
