import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { listOrganizationDisputes } from '~/shared/lib/billing/disputes'
import { withPlatformOrganization } from '~/shared/lib/repositories/billing-risk'

/**
 * Platform-operator read-only view for §8 task 5's chargeback tracking — reuses
 * `repositories/billing-risk.ts`'s `withPlatformOrganization` (same pattern as
 * `api/admin/billing/refunds.ts`). GET only: there is deliberately no operator "decide" mutation
 * here — see `billing/disputes.ts`'s module comment, evidence submission and the won/lost outcome
 * both live in the Stripe Dashboard, not this app. This route exists purely so an operator can see
 * which grants are frozen and why, and when an evidence deadline is coming due.
 */
export const Route = createFileRoute('/api/admin/billing/disputes')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const organizationId = new URL(request.url).searchParams.get('organizationId')
          if (!organizationId) return Response.json({ error: 'organizationId query parameter is required' }, { status: 400 })

          const disputes = await withPlatformOrganization(organizationId, (tx) => listOrganizationDisputes(tx, organizationId))
          return Response.json({ disputes })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin disputes read error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
