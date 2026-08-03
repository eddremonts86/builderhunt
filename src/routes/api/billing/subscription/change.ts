import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { BillingAuthorizationError, requireBillingPermission } from '~/shared/lib/billing/permissions'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { changeSubscription, SubscriptionChangeError, type SubscriptionChangeErrorCode } from '~/shared/lib/billing/subscription-changes'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

const ChangeBody = z.object({
  newCatalogKey: z.string().min(1),
  fingerprint: z.string().min(1),
  idempotencyKey: z.string().min(1),
}).strict()

const SUBSCRIPTION_CHANGE_ERROR_STATUS: Record<SubscriptionChangeErrorCode, number> = {
  no_active_subscription: 409,
  unknown_catalog_key: 400,
  unresolvable_current_plan: 409,
  no_price_configured: 400,
  stale_preview: 409,
  payment_failed: 402,
  requires_action: 402,
  seat_limit_exceeded: 409,
}

export const Route = createFileRoute('/api/billing/subscription/change')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          requireBillingPermission(principal, 'billing:mutate')

          const parsed = ChangeBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const provider = getBillingProvider()
          const result = await withTenantContext(principal, (tx) => changeSubscription(tx, principal, parsed.data, { provider }))
          return Response.json(result)
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof SubscriptionChangeError) {
            return Response.json(
              { error: error.message, code: error.code, ...(error.seatBlocker ? { seatBlocker: error.seatBlocker } : {}) },
              { status: SUBSCRIPTION_CHANGE_ERROR_STATUS[error.code] },
            )
          }
          console.error('Subscription change error:', error)
          return Response.json({ error: 'Failed to change subscription' }, { status: 500 })
        }
      },
    },
  },
})
