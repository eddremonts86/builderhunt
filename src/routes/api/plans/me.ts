import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { PLAN_PRICING } from '~/shared/lib/billing-shared'
import { getOrganizationBillingSummary } from '~/shared/lib/billing/contracts'

/**
 * Legacy compatibility shim (plans/phase-1/30-stripe-billing-platform/tasks.md §9 task 1) — kept for its three
 * live frontend consumers (`settings/billing/index.tsx`'s usage bars, `SearchPage.tsx`'s plan gate),
 * neither of which reads `plan.status`/`billingPeriod`/`currentPeriodEnd`/`trialEndsAt`/`notes`/
 * `seatLimit`/`seatsUsed`/`pricing`/`signedOut` today, but this route preserves every field's shape
 * regardless. Delegates entirely to `getOrganizationBillingSummary` now rather than duplicating its
 * reads — no role gate here (unlike the canonical `/api/billing/summary`), matching this route's own
 * pre-existing, unrestricted-by-role access model exactly.
 */
export const Route = createFileRoute('/api/plans/me')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const summary = await getOrganizationBillingSummary(principal)
          return Response.json({
            plan: {
              userId: principal.userId,
              organizationId: principal.organizationId,
              plan: summary.tier,
              status: summary.status,
              billingPeriod: summary.billingPeriod,
              currentPeriodEnd: summary.currentPeriodEnd,
              trialEndsAt: summary.trialEndsAt,
              notes: summary.notes,
              seatLimit: summary.seats.limit,
              seatsUsed: summary.seats.used,
            },
            // Already `number | null` (unlimited serialized explicitly, not JSON's silent Infinity->null coercion) — see BillingUsageLimitsDto.
            limits: summary.limits,
            usage: summary.usage,
            pricing: PLAN_PRICING,
            signedOut: false,
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ plan: null, signedOut: error.status === 401 }, { status: error.status })
          }
          console.error('plans/me error:', error)
          return Response.json({ error: 'Failed to fetch plan' }, { status: 500 })
        }
      },
    },
  },
})
