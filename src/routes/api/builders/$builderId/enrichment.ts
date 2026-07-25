/**
 * AI Profile Enrichment API (plan: ai-profile-enrichment).
 *
 * GET  -> fresh cached artifact, or generate+persist one if the profile has
 *         enough public signal (see hasEnrichableContent).
 * POST -> same pipeline but skips the freshness check (manual refresh);
 *         rate-limited separately from the daily AI budget.
 *
 * Persistence note: adapted from the original spec's
 * `builders.metadata.aiEnrichment` (legacy per-user table, no longer the
 * live write path — see organization-builders.ts) to
 * `organization_builders.privateMetadata.aiEnrichment`, keyed by the
 * requesting org's own tracked-builder row. A builder must be tracked in
 * the caller's organization to be enriched by that org.
 *
 * The actual pipeline (`runEnrichment`) lives in `~/shared/lib/ai/run-enrichment` so the
 * claim-verification flow (`routes/api/builders/claim/verify.ts`) can fire it too, without
 * duplicating this route's logic.
 */
import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { rateLimit } from '~/shared/lib/rate-limit'
import { runEnrichment } from '~/shared/lib/ai/run-enrichment'
import { AIDisabledError, AIParseError, AIProviderError } from '~/shared/lib/ai/errors'

function errorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof AIParseError) return Response.json({ error: 'ai_parse_failed' }, { status: 502 })
  if (error instanceof AIDisabledError) return Response.json({ error: 'ai_unconfigured' }, { status: 503 })
  if (error instanceof AIProviderError) return Response.json({ error: 'ai_provider_error' }, { status: 502 })
  console.error(fallbackMessage, error)
  return Response.json({ error: fallbackMessage }, { status: 500 })
}

export const Route = createFileRoute('/api/builders/$builderId/enrichment')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const result = await runEnrichment(principal, params.builderId)
          if (result.status === 404) return Response.json({ error: 'Builder not found' }, { status: 404 })
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          return errorResponse(error, 'Failed to fetch enrichment')
        }
      },
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('enrich-refresh', principal.userId, 5, 3600)
          if (!limit.allowed) {
            return Response.json(
              { error: 'rate_limited' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.resetMs / 1000)) } },
            )
          }
          const result = await runEnrichment(principal, params.builderId, { skipFreshnessCheck: true })
          if (result.status === 404) return Response.json({ error: 'Builder not found' }, { status: 404 })
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          return errorResponse(error, 'Failed to refresh enrichment')
        }
      },
    },
  },
})
