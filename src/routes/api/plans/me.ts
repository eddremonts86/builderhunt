import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { PLAN_LIMITS, PLAN_PRICING } from '~/shared/lib/billing-shared'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { countOrganizationBuilders } from '~/shared/lib/repositories/organization-builders'
import { countSavedQueries } from '~/shared/lib/repositories/saved-queries'

export const Route = createFileRoute('/api/plans/me')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const result = await withTenantContext(principal, async (tx) => {
            const [entitlement, savedSearches, savedBuilders] = await Promise.all([
              getOrganizationEntitlement(tx, principal.organizationId),
              countSavedQueries(tx, principal.organizationId),
              countOrganizationBuilders(tx, principal.organizationId),
            ])
            return { entitlement, savedSearches, savedBuilders }
          })
          return Response.json({
            plan: {
              userId: principal.userId,
              organizationId: principal.organizationId,
              plan: result.entitlement.tier,
              status: result.entitlement.status,
            },
            limits: PLAN_LIMITS[result.entitlement.tier],
            usage: { savedSearches: result.savedSearches, savedBuilders: result.savedBuilders },
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
