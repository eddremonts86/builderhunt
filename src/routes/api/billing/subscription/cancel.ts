import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { BillingAuthorizationError, requireBillingPermission } from '~/shared/lib/billing/permissions'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { cancelSubscriptionAtPeriodEnd, SubscriptionChangeError, type SubscriptionChangeErrorCode } from '~/shared/lib/billing/subscription-changes'
import { withWorkerOrganization } from '~/shared/lib/repositories/billing-worker'

const SUBSCRIPTION_CHANGE_ERROR_STATUS: Record<SubscriptionChangeErrorCode, number> = {
  no_active_subscription: 409,
  unknown_catalog_key: 400,
  unresolvable_current_plan: 409,
  no_price_configured: 400,
  stale_preview: 409,
  payment_failed: 402,
  requires_action: 402,
  seat_limit_exceeded: 409,
  // Never raised on this route — the guard lives in `changeSubscription`, because cancelling and
  // previewing an incomplete subscription are both things Stripe allows. Present because the map is
  // exhaustive over the shared code union, which is what surfaced this file when the code was added.
  subscription_incomplete: 409,
}

/**
 * Owner-only, always schedules cancellation for the current period's end (spec.md: never
 * immediate) — no body is required or read, matching `provider.cancelSubscription`'s own
 * `{subscriptionId, atPeriodEnd}` shape, which carries no idempotency key because a second call
 * while already scheduled is naturally a no-op, not a distinct action to dedupe.
 *
 * Runs in a worker-role transaction for the same reason `change.ts` does: `markBillingSubscriptionCancelAtPeriodEnd`
 * updates `billing_subscriptions`, on which `builderhunt_app` holds SELECT only, so under `withTenantContext`
 * this route answered 500 `permission denied` to every owner who clicked cancel. Authorization happens first and
 * in full; `withWorkerOrganization` keeps every row scoped to this organization through the worker RLS policies.
 */
export const Route = createFileRoute('/api/billing/subscription/cancel')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          requireBillingPermission(principal, 'billing:mutate')

          const provider = getBillingProvider()
          const result = await withWorkerOrganization(principal.organizationId, (tx) => cancelSubscriptionAtPeriodEnd(tx, principal, { provider }))
          return Response.json(result)
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof SubscriptionChangeError) {
            return Response.json({ error: error.message, code: error.code }, { status: SUBSCRIPTION_CHANGE_ERROR_STATUS[error.code] })
          }
          console.error('Subscription cancellation error:', error)
          return Response.json({ error: 'Failed to cancel subscription' }, { status: 500 })
        }
      },
    },
  },
})
