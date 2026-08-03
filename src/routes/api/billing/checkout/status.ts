import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getCheckoutReturnStatus } from '~/shared/lib/billing/checkout'
import { BillingAuthorizationError, canReadBillingSummary } from '~/shared/lib/billing/permissions'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

/**
 * Polled by the pending-Checkout return page (`CheckoutReturn.tsx`) — deliberately ignores every
 * query parameter on the request (there are none this handler reads at all), so a URL with a forged
 * `session_id`/`status=success` parameter has zero effect: the answer is derived entirely from the
 * authenticated principal's own organization state via `getCheckoutReturnStatus`.
 */
export const Route = createFileRoute('/api/billing/checkout/status')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          if (!canReadBillingSummary(principal)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }

          const provider = getBillingProvider()
          const result = await withTenantContext(principal, (tx) => getCheckoutReturnStatus(tx, principal, { provider }))
          return Response.json(result)
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Checkout return status error:', error)
          return Response.json({ error: 'Failed to load checkout status' }, { status: 500 })
        }
      },
    },
  },
})
