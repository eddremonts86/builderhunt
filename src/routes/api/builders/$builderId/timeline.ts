/**
 * Per-builder public activity timeline (plan: unified-timeline).
 *
 * GET the last ~30 public events (pushes, releases, PRs, articles, answers)
 * for a tracked builder, read-through cached — never a durable ingestion
 * pipeline. Ownership check mirrors hygiene.ts: the builder must be tracked
 * in the caller's own organization. Never 500s on an upstream failure — the
 * service layer already degrades to an empty result for that.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { findOrganizationBuilderByIdentity } from '~/shared/lib/repositories/organization-builders'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getBuilderTimeline } from '~/lib/timeline'

export const Route = createFileRoute('/api/builders/$builderId/timeline')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        let resolvedSource: string | null = null
        try {
          const principal = await requireTenantPrincipal(request)

          const limit = await rateLimit('timeline', principal.userId, 30, 60)
          if (!limit.allowed) {
            return Response.json(
              { error: 'rate_limited' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.resetMs / 1000)) } },
            )
          }

          const tenantBuilder = await withTenantContext(principal, (tx) =>
            findOrganizationBuilderByIdentity(tx, principal.organizationId, params.builderId),
          )
          if (!tenantBuilder) return Response.json({ error: 'Builder not found' }, { status: 404 })
          resolvedSource = tenantBuilder.source

          const result = await getBuilderTimeline({
            source: tenantBuilder.source as never,
            sourceId: tenantBuilder.sourceId,
            username: tenantBuilder.username,
          })
          return Response.json(result)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Timeline fetch error:', error)
          // Never a 5xx from an upstream/service failure — degrade to an
          // empty, honestly-labeled result instead (getBuilderTimeline
          // itself never throws, so this only guards against a genuine
          // infra error between the two calls above).
          return Response.json({ events: [], source: resolvedSource, supported: true, fetchedAt: new Date().toISOString() })
        }
      },
    },
  },
})
