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
 */
import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import {
  findOrganizationBuilderByIdentity,
  setOrganizationBuilderEnrichment,
} from '~/shared/lib/repositories/organization-builders'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { checkAndConsumeBudget } from '~/shared/lib/ai/budget'
import { getCached, setCached } from '~/shared/lib/ai/cache'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import { getTask } from '~/shared/lib/ai/tasks'
import { buildEnrichInput, hasEnrichableContent, isEnrichmentFresh } from '~/shared/lib/ai/enrichment'
import { rateLimit } from '~/shared/lib/rate-limit'
import { env } from '~/shared/lib/env'
import { AIDisabledError, AIParseError, AIProviderError } from '~/shared/lib/ai/errors'

type EnrichmentResult =
  | { status: 404 }
  | { status: 200; body: { enrichment: unknown; cached: true } }
  | { status: 200; body: { insufficient: true } }
  | { status: 503; body: { error: 'ai_unconfigured' } }
  | { status: 429; body: { error: 'plan' | 'budget' } }
  | { status: 200; body: { enrichment: unknown; cached: false } }

async function runEnrichment(
  principal: TenantPrincipal,
  builderIdentityId: string,
  opts: { skipFreshnessCheck?: boolean } = {},
): Promise<EnrichmentResult> {
  const tenantBuilder = await withTenantContext(principal, (tx) =>
    findOrganizationBuilderByIdentity(tx, principal.organizationId, builderIdentityId),
  )
  if (!tenantBuilder) return { status: 404 }

  const privateMetadata = tenantBuilder.privateMetadata as Record<string, unknown>
  if (!opts.skipFreshnessCheck && isEnrichmentFresh(privateMetadata.aiEnrichment)) {
    return { status: 200, body: { enrichment: privateMetadata.aiEnrichment, cached: true } }
  }

  const input = buildEnrichInput({
    username: tenantBuilder.username,
    displayName: tenantBuilder.displayName,
    source: tenantBuilder.source,
    bio: tenantBuilder.bio,
    topics: Array.isArray(privateMetadata.topics) ? (privateMetadata.topics as string[]) : [],
    language: typeof privateMetadata.language === 'string' ? privateMetadata.language : tenantBuilder.language,
    country: typeof privateMetadata.country === 'string' ? privateMetadata.country : tenantBuilder.country,
    followersCount: tenantBuilder.followersCount,
    metadata: privateMetadata,
  })

  if (!hasEnrichableContent(input)) {
    return { status: 200, body: { insufficient: true } }
  }

  if (env.AI_DISABLED === 'true' || !env.MINIMAX_API_KEY) {
    return { status: 503, body: { error: 'ai_unconfigured' } }
  }

  const task = getTask('profile-enrich')
  if (!task) return { status: 503, body: { error: 'ai_unconfigured' } }

  const entitlement = await withTenantContext(principal, (tx) =>
    getOrganizationEntitlement(tx, principal.organizationId),
  )
  const budget = await checkAndConsumeBudget(principal, entitlement, task)
  if (!budget.allowed) {
    return { status: 429, body: { error: budget.reason ?? 'budget' } }
  }

  const cached = await getCached(task, input)
  const modelOutput = cached ?? await minimaxChat({
    system: task.system,
    prompt: task.buildPrompt(input),
    schema: task.outputSchema,
    maxOutputTokens: task.maxOutputTokens,
  })
  if (!cached) await setCached(task, input, modelOutput)

  const enrichment = {
    ...(modelOutput as Record<string, unknown>),
    enrichedAt: new Date().toISOString(),
    model: env.MINIMAX_MODEL,
    version: 1 as const,
  }
  await withTenantContext(principal, (tx) =>
    setOrganizationBuilderEnrichment(tx, principal.organizationId, builderIdentityId, enrichment),
  )
  return { status: 200, body: { enrichment, cached: false } }
}

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
