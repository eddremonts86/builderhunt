import { createFileRoute } from '@tanstack/react-router'
import { randomId } from '~/lib/utils'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { PLAN_LIMITS } from '~/shared/lib/billing-shared'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { recordMigrationMismatch } from '~/shared/lib/migration/migration-metrics'
import { executeTenantRead } from '~/shared/lib/migration/shadow-read'
import { resolveTenantMigrationModes } from '~/shared/lib/migration/tenant-flags'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import {
  countSavedQueries,
  createSavedQuery,
  deleteSavedQuery,
  listLegacySavedQueries,
  listSavedQueries,
} from '~/shared/lib/repositories/saved-queries'

export const Route = createFileRoute('/api/queries/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const modes = resolveTenantMigrationModes(env, { canonicalReady: env.TENANT_CANONICAL_READY })
          const queries = await withTenantContext(principal, (tx) => executeTenantRead(modes.read, {
            surface: 'saved-queries',
            requestId: principal.requestId,
            legacy: () => listLegacySavedQueries(tx, principal.userId),
            canonical: () => listSavedQueries(tx, principal.organizationId),
            recordMismatch: recordMigrationMismatch,
          }))
          return Response.json(queries)
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
            const limit = PLAN_LIMITS[entitlement.tier].savedSearches
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
