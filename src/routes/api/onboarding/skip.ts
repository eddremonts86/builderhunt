import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { skipOnboarding } from '~/shared/lib/onboarding'

export const Route = createFileRoute('/api/onboarding/skip')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

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
