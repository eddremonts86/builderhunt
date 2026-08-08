import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { pageBuilderSearch } from '~/lib/search'
import { SearchContinuationError } from '~/lib/search-continuation'
import { recordIngestedSourceObservations, upsertEmbeddingStubs } from '~/lib/semantic/index-writer'
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
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

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
          const { keywords, sources, language, country, cursor } = body
          const keywordsArray = typeof keywords === 'string'
            ? keywords.split(/[,\s]+/).filter(Boolean)
            : Array.isArray(keywords) ? keywords : []

          let page: Awaited<ReturnType<typeof pageBuilderSearch>>
          try {
            page = await pageBuilderSearch({
              keywords: keywordsArray,
              sources: Array.isArray(sources) ? sources : undefined,
              language,
              country,
              // Search reads no tenant-scoped rows, but the continuation is still bound to who
              // asked — a token is a token, and scoping it only where a boundary happens to exist
              // is how the one place it does get missed.
              scope: principal?.organizationId ?? 'anon',
              mode: 'keyword',
              cursor: typeof cursor === 'string' ? cursor : null,
            })
          } catch (error) {
            if (error instanceof SearchContinuationError) {
              // 400 and no rows. The client drops the cursor and restarts at page one — which is
              // exactly right when the query, the filters or the enabled sources have moved.
              return Response.json({ error: error.message }, { status: error.status })
            }
            throw error
          }
          const results = page.builders
          const sourceStatuses = page.sources

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
          recordIngestedSourceObservations(results).catch((err) => log.error('source_observation_writethrough_error', { error: err instanceof Error ? err.message : String(err) }))

          return Response.json({
            builders: annotated,
            /**
             * Opaque and signed. `page`/`perPage`/`hasMore` were here and are gone (plan 11): the
             * response was up to `sources × perPage` rows, and `hasMore` compared that cross-source
             * total against a per-source ask, so it was true on virtually every response.
             */
            nextCursor: page.nextCursor,
            /** Never a number. Counting would mean exhausting thirteen third-party APIs. */
            total: page.total,
            consistency: page.consistency,
            // Per-source health (plan 43 Phase 2). Connector isolation means a broken source now
            // yields partial results instead of a 500 — which would be a silent downgrade if the
            // response did not say so. The UI can tell "nobody matched" from "GitHub was down".
            sources: sourceStatuses,
            degraded: page.degraded,
          })
        } catch (err) {
          console.error('Search error:', err)
          return Response.json({ error: 'Search failed' }, { status: 500 })
        }
      },
    },
  },
})
