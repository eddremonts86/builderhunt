import { createFileRoute } from '@tanstack/react-router'
import { count, eq } from 'drizzle-orm'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { PLAN_LIMITS, PLAN_PRICING } from '~/shared/lib/billing-shared'
import { organizationEntitlements, organizationMembers } from '~/shared/lib/db/schema'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getOrganizationEntitlement, resolveLegacyPlanTier } from '~/shared/lib/repositories/entitlements'
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
            const [entitlement, savedSearches, savedBuilders, entitlementDetailRows, memberCountRows] = await Promise.all([
              getOrganizationEntitlement(tx, principal.organizationId),
              countSavedQueries(tx, principal.organizationId),
              countOrganizationBuilders(tx, principal.organizationId),
              tx.select({
                billingPeriod: organizationEntitlements.billingPeriod,
                currentPeriodEnd: organizationEntitlements.currentPeriodEnd,
                trialEndsAt: organizationEntitlements.trialEndsAt,
                notes: organizationEntitlements.notes,
              }).from(organizationEntitlements)
                .where(eq(organizationEntitlements.organizationId, principal.organizationId))
                .limit(1),
              tx.select({ value: count() }).from(organizationMembers)
                .where(eq(organizationMembers.organizationId, principal.organizationId)),
            ])
            const detail = entitlementDetailRows[0] ?? null
            return {
              entitlement,
              savedSearches,
              savedBuilders,
              billingPeriod: detail?.billingPeriod ?? 'none',
              currentPeriodEnd: detail?.currentPeriodEnd?.toISOString() ?? null,
              trialEndsAt: detail?.trialEndsAt?.toISOString() ?? null,
              notes: detail?.notes ?? null,
              seatsUsed: memberCountRows[0]?.value ?? 1,
            }
          })
          return Response.json({
            plan: {
              userId: principal.userId,
              organizationId: principal.organizationId,
              plan: result.entitlement.tier,
              status: result.entitlement.status,
              billingPeriod: result.billingPeriod,
              currentPeriodEnd: result.currentPeriodEnd,
              trialEndsAt: result.trialEndsAt,
              notes: result.notes,
              seatLimit: result.entitlement.seatLimit,
              seatsUsed: result.seatsUsed,
            },
            limits: PLAN_LIMITS[resolveLegacyPlanTier(result.entitlement.tier)],
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
