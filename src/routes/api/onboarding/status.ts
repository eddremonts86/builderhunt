import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getOnboardingStatus } from '~/shared/lib/onboarding'

export const Route = createFileRoute('/api/onboarding/status')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const status = await withTenantContext(principal, (tx) =>
            getOnboardingStatus(tx, principal.organizationId, principal.userId))
          return Response.json(status)
        } catch (err) {
          if (err instanceof TenantAuthorizationError) {
            return Response.json({ error: err.message }, { status: err.status })
          }
          console.error('Onboarding status error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
