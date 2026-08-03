import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { randomId } from '~/lib/utils'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { PLAN_LIMITS } from '~/shared/lib/billing-shared'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getOrganizationEntitlement, resolveLegacyPlanTier } from '~/shared/lib/repositories/entitlements'
import {
  countSavedQueries,
  createSavedQuery,
  deleteSavedQuery,
  listSavedQueries,
} from '~/shared/lib/repositories/saved-queries'
// `~/shared/lib/repositories/public-radars` imports `publicDb`, which eagerly
// opens a real `postgres()` client at module scope — imported dynamically
// below (not statically here) to keep that chain out of the client bundle.
// See the matching note in src/lib/sources/devpost.ts.

export const Route = createFileRoute('/api/queries/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST', 'DELETE']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          /**
           * A saved search belongs to the organization, full stop.
           *
           * This used to branch on `TENANT_READ_MODE`: `legacy` returned only what the calling member had
           * saved, `canonical` the whole organization's. The switch existed as the tenant cutover's rollback.
           * It was retired on 2026-08-03 — there are no real users to roll back for, and the two answers
           * diverge *by design* for any organization with two contributing members, so "flip back to legacy" was
           * never a recovery from a bug. It was a second, quieter product.
           *
           * Keeping it also meant the shared-workspace promise depended on an environment variable: a
           * deployment that never set `TENANT_READ_MODE=canonical` silently hid teammates' saved searches from
           * each other, which is the feature, not a fallback.
           */
          const queries = await withTenantContext(principal, (tx) => listSavedQueries(tx, principal.organizationId))
          const { listPublicRadarSlugsForSavedQueryIds } = await import('~/shared/lib/repositories/public-radars')
          const radarSlugs = await listPublicRadarSlugsForSavedQueryIds(queries.map((query) => query.id))
          return Response.json(queries.map((query) => ({
            ...query,
            radarSlug: radarSlugs.get(query.id) ?? null,
          })))
        } catch (error) {
          const authorizationResponse = tenantAuthorizationResponse(error)
          if (authorizationResponse) return authorizationResponse
          console.error('Queries list error:', error)
          return Response.json({ error: 'Failed to fetch queries' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rateLimitKey = `${principal.organizationId}:${principal.userId}`
          const limitResult = await rateLimit('saved-search-create', rateLimitKey, 20, 24 * 60 * 60)
          if (!limitResult.allowed) {
            return Response.json(
              { error: 'Too many saved searches created today. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limitResult.resetMs / 1000)) } },
            )
          }

          const body = await request.json() as Record<string, unknown>
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          const keywords = Array.isArray(body.keywords)
            ? body.keywords.filter((value): value is string => typeof value === 'string')
            : []
          const sources = Array.isArray(body.sources)
            ? body.sources.filter((value): value is string => typeof value === 'string')
            : ['github']
          if (!name || keywords.length === 0) {
            return Response.json({ error: 'Name and keywords are required' }, { status: 400 })
          }

          const result = await withTenantContext(principal, async (tx) => {
            const entitlement = await getOrganizationEntitlement(tx, principal.organizationId)
            const current = await countSavedQueries(tx, principal.organizationId)
            const limit = PLAN_LIMITS[resolveLegacyPlanTier(entitlement.tier)].savedSearches
            if (current >= limit) return { query: null, limit, current, plan: entitlement.tier }
            const query = await createSavedQuery(tx, {
              id: randomId(),
              organizationId: principal.organizationId,
              createdByUserId: principal.userId,
              name,
              keywords,
              sources,
              language: typeof body.language === 'string' ? body.language : null,
              country: typeof body.country === 'string' ? body.country : null,
            })
            return { query, limit, current, plan: entitlement.tier }
          })

          if (!result.query) {
            return Response.json({
              error: `You've reached the ${result.plan} plan limit of ${result.limit} saved searches. Upgrade to save more.`,
              limit: result.limit,
              current: result.current,
              plan: result.plan,
              upgradeUrl: '/pricing',
            }, { status: 402 })
          }
          return Response.json(result.query)
        } catch (error) {
          const authorizationResponse = tenantAuthorizationResponse(error)
          if (authorizationResponse) return authorizationResponse
          console.error('Query create error:', error)
          return Response.json({ error: 'Failed to create query' }, { status: 500 })
        }
      },
      DELETE: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const body = await request.json() as Record<string, unknown>
          if (typeof body.id !== 'string' || !body.id) {
            return Response.json({ error: 'id required' }, { status: 400 })
          }
          const deleted = await withTenantContext(principal, (tx) =>
            deleteSavedQuery(tx, principal.organizationId, body.id as string),
          )
          if (!deleted) return Response.json({ error: 'Query not found or not yours' }, { status: 404 })
          return Response.json({ success: true })
        } catch (error) {
          const authorizationResponse = tenantAuthorizationResponse(error)
          if (authorizationResponse) return authorizationResponse
          console.error('Query delete error:', error)
          return Response.json({ error: 'Failed to delete query' }, { status: 500 })
        }
      },
    },
  },
})

function tenantAuthorizationResponse(error: unknown) {
  return error instanceof TenantAuthorizationError
    ? Response.json({ error: error.message }, { status: error.status })
    : null
}
