import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { BillingAuthorizationError, requireBillingPermission } from '~/shared/lib/billing/permissions'
import { createPackCheckout, PackCheckoutError, type PackCheckoutErrorCode } from '~/shared/lib/billing/packs'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

const CheckoutDisclosuresBody = z.object({
  renewal: z.literal(true),
  amount: z.literal(true),
  interval: z.literal(true),
  cancellationRefundPolicy: z.literal(true),
  creditExpiryNonTransferability: z.literal(true),
  tax: z.literal(true),
  total: z.literal(true),
}).strict()

const PackCheckoutBody = z.object({
  catalogKey: z.string().min(1),
  country: z.string().length(2),
  disclosures: CheckoutDisclosuresBody,
  idempotencyKey: z.string().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
}).strict()

const PACK_CHECKOUT_ERROR_STATUS: Record<PackCheckoutErrorCode, number> = {
  billing_disabled: 503,
  country_not_allowed: 403,
  unknown_catalog_key: 400,
  no_active_subscription: 403,
  risk_limit_exceeded: 429,
  risk_blocked: 403,
  invalid_url: 400,
  provider_error: 502,
}

export const Route = createFileRoute('/api/billing/checkout/credits')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          requireBillingPermission(principal, 'billing:mutate')

          const parsed = PackCheckoutBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const provider = getBillingProvider()
          const result = await withTenantContext(principal, (tx) => createPackCheckout(tx, principal, parsed.data, { provider }))
          return Response.json(result)
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof PackCheckoutError) {
            return Response.json({ error: error.message, code: error.code }, { status: PACK_CHECKOUT_ERROR_STATUS[error.code] })
          }
          console.error('Pack checkout error:', error)
          return Response.json({ error: 'Failed to start checkout' }, { status: 500 })
        }
      },
    },
  },
})
