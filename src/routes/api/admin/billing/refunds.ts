import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { REFUND_POLICY_DECISIONS } from '~/shared/lib/billing-shared'
import { decideRefund, RefundError, type RefundErrorCode } from '~/shared/lib/billing/refunds'
import { withPlatformOrganization } from '~/shared/lib/repositories/billing-risk'
import { pageBillingRefunds } from '~/shared/lib/repositories/billing'
import { billingRefundsCapability } from '~/shared/lib/table/capabilities/billing-refunds'
import { platformTablePageHandler, TablePageError } from '~/shared/lib/table/handler'

const DecideRefundBody = z.object({
  organizationId: z.string().min(1),
  refundId: z.string().min(1),
  policyDecision: z.enum(REFUND_POLICY_DECISIONS),
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
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PUT']),

      /**
       * One keyset page of the queue, for one organization.
       *
       * The organization arrives as `?filter.organizationId=…` rather than as its own parameter,
       * and that is the whole shape of this change. It used to be a precondition: supply an id and
       * the route read **every** refund that organization had ever requested. Now it is a filter
       * dimension like any other — it lives in the table's state, so it is in the URL, it is part
       * of what the cursor is bound to, and an empty result under a typed id renders the
       * filtered-empty state instead of "this organization has no refunds".
       *
       * It is still required, and exactly one value: `builderhunt_platform`'s SELECT policy on
       * `billing_refunds` is org-scoped (drizzle/0028), so the read has to be scoped to one
       * organization before it runs. Two values cannot both be `set_config`'d, and answering with
       * whichever came first would silently show one workspace's refunds under a filter naming two.
       */
      GET: async ({ request }) => platformTablePageHandler({
        capability: billingRefundsCapability,
        request,
        load: ({ search }) => {
          const selected = search.query.filters.organizationId ?? []
          if (selected.length !== 1) {
            throw new TablePageError(400, 'Exactly one filter.organizationId is required')
          }
          return withPlatformOrganization(selected[0], (tx) =>
            pageBillingRefunds(tx, search.query, search.page))
        },
      }),
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
