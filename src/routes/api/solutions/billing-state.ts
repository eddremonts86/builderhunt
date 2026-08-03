/**
 * `GET /api/solutions/billing-state` — what the Solutions surface needs to decide what to offer (plan 43
 * Phase 8).
 *
 * Returns a *decision* per operation plus the exact charge, from `describeSolutionsBillingState`. The client
 * does not compare a balance against a price itself: an enabled button whose charge the platform then refuses is
 * worse than a disabled one, because the user has already confirmed a price by the time they find out.
 *
 * The `charge` here is what a client echoes back in `POST /api/solutions/generate`'s `confirmation`, which is
 * how a stale price gets refused instead of silently billed at the new one.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { describeSolutionsBillingState } from '~/modules/solutions/server/billing-state'

export const Route = createFileRoute('/api/solutions/billing-state')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const state = await withTenantContext(principal, (tx) => describeSolutionsBillingState(tx, principal))
          return Response.json(state, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Solutions billing state error:', error)
          return Response.json({ error: 'Failed to load Solutions billing state' }, { status: 500 })
        }
      },
    },
  },
})
