import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { searchBuilders } from '~/lib/search'
import { semanticSearch } from '~/lib/semantic/semantic-search'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getTask } from '~/shared/lib/ai/tasks'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { log } from '~/shared/lib/log'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { getTrackedBuilderIds, trackedKey } from '~/shared/lib/tracked-builders'

const SemanticSearchBody = z.object({
  query: z.string().min(3).max(300),
  translated: z.unknown().optional(),
  sources: z.array(z.string()).optional(),
  language: z.string().optional(),
  country: z.string().optional(),
  page: z.number().int().positive().optional(),
  perPage: z.number().int().positive().max(50).optional(),
})

/**
 * Semantic search over the global `builder_embeddings` index (spec.md §5).
 * Pro/team only. Any failure — embed error, translate error, missing
 * pgvector extension — degrades to plain keyword search rather than a dead
 * end (`mode: 'keyword-fallback'`).
 */
export const Route = createFileRoute('/api/search/semantic')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          const parsed = SemanticSearchBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const entitlement = await withTenantContext(principal, (tx) =>
            getOrganizationEntitlement(tx, principal.organizationId),
          )
          if (entitlement.tier === 'free') {
            return Response.json({ error: 'plan' }, { status: 403 })
          }

          const rl = await rateLimit('search-semantic', principal.userId, 20, 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many semantic search requests. Please slow down.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          // Client may have already run query-translate via Chrome AI —
          // re-validate against the registry schema regardless.
          const queryTranslateTask = getTask('query-translate')
          const translated = queryTranslateTask
            ? queryTranslateTask.outputSchema.safeParse(parsed.data.translated)
            : null
          const translatedInput = translated?.success ? translated.data : undefined

          const perPage = parsed.data.perPage ?? 30
          const page = parsed.data.page ?? 1
          let builders: Array<{ source: string; sourceId: string }>
          let mode: 'semantic' | 'hybrid' | 'keyword-fallback'
          let translatedOut = translatedInput
          let hasMore: boolean

          try {
            // `sources` and `page` were accepted by this schema and then dropped on the floor until
            // plan 43 Phase 2 — the endpoint advertised a filter and a pager it did not honor.
            const outcome = await semanticSearch({
              query: parsed.data.query,
              translated: translatedInput,
              sources: parsed.data.sources,
              language: parsed.data.language,
              country: parsed.data.country,
              page,
              perPage,
              principal,
              entitlement,
            })
            builders = outcome.results
            mode = outcome.mode
            translatedOut = outcome.translated ?? translatedInput
            hasMore = outcome.hasMore
          } catch (error) {
            log.error('semantic_search_route_error', { error: error instanceof Error ? error.message : String(error) })
            const fallback = await searchBuilders({
              keywords: parsed.data.query.split(/\s+/).filter(Boolean),
              sources: parsed.data.sources,
              language: parsed.data.language,
              country: parsed.data.country,
              page,
              perPage,
            })
            builders = fallback
            mode = 'keyword-fallback'
            hasMore = fallback.length >= perPage
          }

          let trackedIds = new Map<string, string>()
          try {
            trackedIds = await withTenantContext(principal, (tx) =>
              getTrackedBuilderIds(tx, principal.organizationId),
            )
          } catch (err) {
            console.error('getTrackedBuilderIds error:', err)
          }
          const annotated = builders.map((b) => {
            const trackedRowId = trackedIds.get(trackedKey(b.source, b.sourceId))
            return {
              ...b,
              tracked: trackedRowId !== undefined,
              trackedRowId,
            }
          })

          return Response.json({
            builders: annotated,
            mode,
            translated: translatedOut,
            page,
            perPage,
            hasMore,
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Semantic search error:', error)
          return Response.json({ error: 'Search failed' }, { status: 500 })
        }
      },
    },
  },
})
