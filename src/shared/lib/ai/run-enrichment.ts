/**
 * AI profile-enrichment pipeline (plan: ai-profile-enrichment). Extracted from
 * `routes/api/builders/$builderId/enrichment.ts` (Phase 3, "Trigger enrichment on successful
 * claim") so the claim-verification flow can fire it too, without duplicating the GET/POST
 * route's logic.
 *
 * Persistence note: `organization_builders.privateMetadata.aiEnrichment`, keyed by the calling
 * principal's own organization's tracked-builder row — a builder must be tracked in that
 * organization to be enriched by it (see organization-builders.ts). `runEnrichment` resolves
 * `{ status: 404 }` rather than throwing when the identity isn't tracked in that org, and
 * resolves benignly (`ai_unconfigured`/`insufficient`/budget-exhausted) for every other
 * expected non-error outcome — every caller, including a fire-and-forget one, can safely
 * `.catch()` this promise for genuine failures (AI provider errors, parse failures) without
 * worrying that a plain "nothing to enrich yet" case throws.
 */
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
import { env } from '~/shared/lib/env'

export type EnrichmentResult =
  | { status: 404 }
  | { status: 200; body: { enrichment: unknown; cached: true } }
  | { status: 200; body: { insufficient: true } }
  | { status: 503; body: { error: 'ai_unconfigured' } }
  | { status: 429; body: { error: 'plan' | 'budget' } }
  | { status: 200; body: { enrichment: unknown; cached: false } }

export async function runEnrichment(
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
