import { createFileRoute } from '@tanstack/react-router'
import { searchBuildersWithStatus } from '~/lib/search'
import { upsertEmbeddingStubs } from '~/lib/semantic/index-writer'
import { rateLimit, getRateLimitId, getAuthedRateLimitId } from '~/shared/lib/rate-limit'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getTrackedBuilderIds, trackedKey } from '~/shared/lib/tracked-builders'
import { log } from '~/shared/lib/log'
import { meterSeatActionAndEmit } from '~/shared/lib/abuse/anomalies'
import { env } from '~/shared/lib/env'

export const Route = createFileRoute('/api/search/builders')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          // Resolve the principal up front (best-effort — search also serves anonymous
          // visitors) so the rate limit below can key on identity, not IP, for signed-in users:
          // an authenticated user rotating IPs must not get a fresh bucket every time.
          let principal: Awaited<ReturnType<typeof requireTenantPrincipal>> | null = null
          try {
            principal = await requireTenantPrincipal(request)
          } catch {
            principal = null
          }

          const rateLimitId = principal
            ? getAuthedRateLimitId({ userId: principal.userId, organizationId: principal.organizationId })
            : getRateLimitId(request)
          const rl = await rateLimit('search-builders', rateLimitId, 60, 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many search requests. Please slow down.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const body = await request.json()
          const {
            keywords,
            sources,
            language,
            country,
            page = 1,
            perPage = 30,
          } = body
          const keywordsArray = typeof keywords === 'string'
            ? keywords.split(/[,\s]+/).filter(Boolean)
            : Array.isArray(keywords) ? keywords : []
          const { builders: results, sources: sourceStatuses } = await searchBuildersWithStatus({
            keywords: keywordsArray,
            sources: Array.isArray(sources) ? sources : undefined,
            language,
            country,
            page,
            perPage,
          })

          let trackedIds = new Map<string, string>()
          if (principal) {
            try {
              trackedIds = await withTenantContext(principal, async (tx) => {
                // Meter (abuse-and-usage-integrity Phase 4 "core actions per seat") — count only,
                // observe-only, never blocks.
                await meterSeatActionAndEmit(tx, {
                  organizationId: principal!.organizationId,
                  userId: principal!.userId,
                  action: 'searches',
                  cap: env.SEAT_DAILY_SEARCHES,
                  requestId: principal!.requestId,
                })
                return getTrackedBuilderIds(tx, principal!.organizationId)
              })
            } catch (err) {
              // Best-effort — a resolved principal with no active organization still shouldn't
              // break search.
              console.error('getTrackedBuilderIds error:', err)
            }
          }
          const annotated = results.map((b) => {
            const trackedRowId = trackedIds.get(trackedKey(b.source, b.sourceId))
            return {
              ...b,
              tracked: trackedRowId !== undefined,
              trackedRowId,
            }
          })

          // Write-through indexing for semantic-search — fire-and-forget,
          // never awaited on the response (see src/lib/semantic/index-writer.ts).
          upsertEmbeddingStubs(results).catch((err) => log.error('embedding_writethrough_error', { error: err instanceof Error ? err.message : String(err) }))

          return Response.json({
            builders: annotated,
            page,
            perPage,
            hasMore: results.length >= perPage,
            // Per-source health (plan 43 Phase 2). Connector isolation means a broken source now
            // yields partial results instead of a 500 — which would be a silent downgrade if the
            // response did not say so. The UI can tell "nobody matched" from "GitHub was down".
            sources: sourceStatuses,
            degraded: sourceStatuses.some((status) => status.health !== 'ok'),
          })
        } catch (err) {
          console.error('Search error:', err)
          return Response.json({ error: 'Search failed' }, { status: 500 })
        }
      },
    },
  },
})
