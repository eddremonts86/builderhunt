import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getBillingAvailability, getOrganizationBillingSummary } from '~/shared/lib/billing/contracts'
import { canReadBillingSummary } from '~/shared/lib/billing/permissions'

/**
 * The canonical billing read (plans/phase-1/30-stripe-billing-platform/tasks.md §9 task 1) — role-minimized per
 * spec.md §Permissions and UX: owner/admin get the full `OrganizationBillingSummaryDto`, a plain
 * member gets only `BillingAvailabilityDto` (feature availability, no financial detail).
 * `/api/plans/me` is the legacy compatibility route this replaces; it now delegates to
 * `getOrganizationBillingSummary` internally rather than duplicating these reads.
 */
export const Route = createFileRoute('/api/billing/summary')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          if (canReadBillingSummary(principal)) {
            const summary = await getOrganizationBillingSummary(principal)
            return Response.json(summary)
          }
          const availability = await getBillingAvailability(principal)
          return Response.json(availability)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('billing summary error:', error)
          return Response.json({ error: 'Failed to load billing summary' }, { status: 500 })
        }
      },
    },
  },
})
