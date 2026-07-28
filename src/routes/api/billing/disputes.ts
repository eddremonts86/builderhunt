import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { listOrganizationDisputes } from '~/shared/lib/billing/disputes'
import { canReadBillingSummary } from '~/shared/lib/billing/permissions'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

/**
 * Owner-facing dispute visibility (plans/phase-1/29-stripe-billing-platform/tasks.md §9 task 2) — the admin
 * `api/admin/billing/disputes.ts` route is platform-operator, cross-org; this one is tenant-scoped
 * (`billing:read`, matching every other financial-summary read) so an organization can see its own
 * chargebacks without a second, admin-only surface. Pack disputes only — see `billing/disputes.ts`'s
 * own module comment for why a subscription-invoice dispute is a documented, separate gap.
 */
export const Route = createFileRoute('/api/billing/disputes')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          if (!canReadBillingSummary(principal)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const disputes = await withTenantContext(principal, (tx) => listOrganizationDisputes(tx, principal.organizationId))
          return Response.json({ disputes })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Billing disputes read error:', error)
          return Response.json({ error: 'Failed to read disputes' }, { status: 500 })
        }
      },
    },
  },
})
