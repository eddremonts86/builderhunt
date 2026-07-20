import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { skipOnboarding } from '~/shared/lib/onboarding'

export const Route = createFileRoute('/api/onboarding/skip')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const status = await withTenantContext(principal, (tx) =>
            skipOnboarding(tx, principal.organizationId, principal.userId))
          return Response.json({ ok: true, status })
        } catch (err) {
          if (err instanceof TenantAuthorizationError) {
            return Response.json({ error: err.message }, { status: err.status })
          }
          console.error('Onboarding skip error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
