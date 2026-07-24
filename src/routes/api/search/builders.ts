import { createFileRoute } from '@tanstack/react-router'
import { searchBuilders } from '~/lib/search'
import { upsertEmbeddingStubs } from '~/lib/semantic/index-writer'
import { rateLimit, getRateLimitId } from '~/shared/lib/rate-limit'
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
          const rl = await rateLimit('search-builders', getRateLimitId(request), 60, 60)
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
          const results = await searchBuilders({
            keywords: keywordsArray,
            sources: Array.isArray(sources) ? sources : undefined,
            language,
            country,
            page,
            perPage,
          })

          let trackedIds = new Map<string, string>()
          try {
            const principal = await requireTenantPrincipal(request)
            trackedIds = await withTenantContext(principal, async (tx) => {
              // Meter (abuse-and-usage-integrity Phase 4 "core actions per seat") — count only,
              // observe-only, never blocks; anonymous/no-active-org search (caught below) simply
              // isn't metered, since there's no seat to attribute it to.
              await meterSeatActionAndEmit(tx, {
                organizationId: principal.organizationId,
                userId: principal.userId,
                action: 'searches',
                cap: env.SEAT_DAILY_SEARCHES,
                requestId: principal.requestId,
              })
              return getTrackedBuilderIds(tx, principal.organizationId)
            })
          } catch (err) {
            // Best-effort for anonymous search and sessions without an active organization.
            console.error('getTrackedBuilderIds error:', err)
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
          })
        } catch (err) {
          console.error('Search error:', err)
          return Response.json({ error: 'Search failed' }, { status: 500 })
        }
      },
    },
  },
})
