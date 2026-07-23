import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { BillingAuthorizationError, requireBillingPermission } from '~/shared/lib/billing/permissions'
import { RefundError, requestPackRefund, type RefundErrorCode } from '~/shared/lib/billing/refunds'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

const RequestRefundBody = z.object({
  grantId: z.string().min(1),
  idempotencyKey: z.string().min(1),
}).strict()

const REFUND_ERROR_STATUS: Record<RefundErrorCode, number> = {
  grant_not_found: 404,
  not_a_pack_grant: 400,
  partially_used: 409,
  not_active: 409,
  unknown_pack_catalog_key: 400,
  decision_conflict: 409,
}

/** Owner-only and recent-auth-gated (`'billing:refund'` is in `RECENT_AUTH_REQUIRED_BILLING_ACTIONS`) — spec.md's API contract: "Submit eligible unused-pack request; never directly decide exception." */
export const Route = createFileRoute('/api/billing/refunds')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const authSession = await auth.api.getSession({ headers: request.headers })
          requireBillingPermission(
            principal,
            'billing:refund',
            authSession ? { authenticatedAt: new Date(authSession.session.createdAt) } : undefined,
          )

          const parsed = RequestRefundBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const refund = await withTenantContext(principal, (tx) => requestPackRefund(tx, principal, parsed.data))
          return Response.json({ refund })
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof RefundError) {
            return Response.json({ error: error.message, code: error.code }, { status: REFUND_ERROR_STATUS[error.code] })
          }
          console.error('Refund request error:', error)
          return Response.json({ error: 'Failed to submit refund request' }, { status: 500 })
        }
      },
    },
  },
})
