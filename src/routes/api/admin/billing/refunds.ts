import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { decideRefund, RefundError, type RefundErrorCode } from '~/shared/lib/billing/refunds'
import { withPlatformOrganization } from '~/shared/lib/repositories/billing-risk'
import { listBillingRefunds } from '~/shared/lib/repositories/billing'

const DecideRefundBody = z.object({
  organizationId: z.string().min(1),
  refundId: z.string().min(1),
  policyDecision: z.enum(['full_unused_pack', 'partial_pack_operator', 'full_subscription_invoice', 'partial_subscription_operator']),
  amountCents: z.number().int().nonnegative(),
  creditRevocationUnits: z.number().int().positive().optional(),
  revisedServiceEndAt: z.string().datetime().optional(),
}).strict()

const REFUND_ERROR_STATUS: Record<RefundErrorCode, number> = {
  grant_not_found: 404,
  not_a_pack_grant: 400,
  partially_used: 409,
  not_active: 409,
  unknown_pack_catalog_key: 400,
  decision_conflict: 409,
}

/**
 * Platform-operator review queue for §8 task 4 — reuses `repositories/billing-risk.ts`'s
 * `withPlatformOrganization` (the same platform-role, cross-org-target RLS-scoping helper §8 task 3
 * introduced) rather than duplicating it, since the need is identical: act on one organization's
 * tenant-private rows without an ambient tenant session for it. This route only records the
 * operator's DECISION — actual refund PROCESSING (sending it to Stripe) happens in `worker.ts`'s
 * `sweepPendingRefunds`, never synchronously from this route, matching every other financial
 * mutation in this codebase going through the worker role.
 */
export const Route = createFileRoute('/api/admin/billing/refunds')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const organizationId = new URL(request.url).searchParams.get('organizationId')
          if (!organizationId) return Response.json({ error: 'organizationId query parameter is required' }, { status: 400 })

          const refunds = await withPlatformOrganization(organizationId, (tx) => listBillingRefunds(tx, organizationId))
          return Response.json({ refunds })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin refunds read error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      PUT: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = DecideRefundBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const refund = await withPlatformOrganization(parsed.data.organizationId, (tx) => decideRefund(tx, principal, parsed.data.organizationId, {
            refundId: parsed.data.refundId,
            policyDecision: parsed.data.policyDecision,
            amountCents: parsed.data.amountCents,
            creditRevocationUnits: parsed.data.creditRevocationUnits,
            revisedServiceEndAt: parsed.data.revisedServiceEndAt ? new Date(parsed.data.revisedServiceEndAt) : undefined,
          }))
          await auditPlatformAdminAction(principal, {
            action: 'admin.billing.refund.decide',
            targetType: 'billing_refund',
            targetId: refund.id,
            organizationId: refund.organizationId,
            result: 'allowed',
            details: { policyDecision: refund.policyDecision, amountCents: refund.amountCents },
          })
          return Response.json({ refund })
        } catch (err) {
          if (err instanceof RefundError) {
            return Response.json({ error: err.message, code: err.code }, { status: REFUND_ERROR_STATUS[err.code] })
          }
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin refunds decide error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
