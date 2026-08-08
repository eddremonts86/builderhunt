import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { pageBuilderSearch } from '~/lib/search'
import { SearchContinuationError, SEARCH_CONTINUATION_MAX_LENGTH } from '~/lib/search-continuation'
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
  /**
   * The previous page's `nextCursor`. `page`/`perPage` were here and are gone (plan 11): a page
   * number over an approximate vector index repeats and drops rows whenever the corpus changes,
   * and the write-through indexer changes it on every federated search.
   *
   * Length-capped here as well as inside `verifySearchContinuation`, so an oversized token is a
   * schema error rather than work the server does before refusing.
   */
  cursor: z.string().max(SEARCH_CONTINUATION_MAX_LENGTH).nullish(),
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

          const cursor = parsed.data.cursor ?? null
          let builders: Array<{ source: string; sourceId: string }>
          let mode: 'semantic' | 'hybrid' | 'keyword-fallback'
          let translatedOut = translatedInput
          let nextCursor: string | null
          let consistency: 'approximate' | 'provider-best-effort'

          try {
            // `sources` and the pager were accepted by this schema and then dropped on the floor
            // until plan 43 Phase 2 — the endpoint advertised a filter and a pager it did not honor.
            const outcome = await semanticSearch({
              query: parsed.data.query,
              translated: translatedInput,
              sources: parsed.data.sources,
              language: parsed.data.language,
              country: parsed.data.country,
              cursor,
              principal,
              entitlement,
            })
            builders = outcome.results
            mode = outcome.mode
            translatedOut = outcome.translated ?? translatedInput
            nextCursor = outcome.nextCursor
            consistency = outcome.consistency === 'approximate' ? 'approximate' : 'provider-best-effort'
          } catch (error) {
            /*
             * A refused continuation is the client's problem, not a reason to degrade.
             *
             * Without this branch the catch-all below would swallow it and answer 200 with
             * `keyword-fallback` results — telling the user the AI had failed when in fact their
             * cursor was stale, and giving them no signal to drop it. Checked before the log, so a
             * stale cursor does not read as a semantic-search outage in the logs either.
             */
            if (error instanceof SearchContinuationError) {
              return Response.json({ error: error.message }, { status: error.status })
            }
            log.error('semantic_search_route_error', { error: error instanceof Error ? error.message : String(error) })
            const fallback = await pageBuilderSearch({
              keywords: parsed.data.query.split(/\s+/).filter(Boolean),
              sources: parsed.data.sources,
              language: parsed.data.language,
              country: parsed.data.country,
              scope: principal.organizationId,
              mode: 'keyword-fallback',
              // Not `cursor`: the cursor that reached this branch belongs to a mode that is no
              // longer running. Restarting at page one is the honest answer to "the AI just broke",
              // and `keyword-fallback` in the response is what tells the client to drop what it holds.
              cursor: null,
            })
            builders = fallback.builders
            mode = 'keyword-fallback'
            nextCursor = fallback.nextCursor
            consistency = 'provider-best-effort'
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
            nextCursor,
            /** Never a number — see `SemanticSearchOutcome.total`. */
            total: null,
            consistency,
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
