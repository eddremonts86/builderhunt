/**
 * Team Synergy API (plan: team-synergy).
 *
 * POST compares one tracked candidate against the caller's own org's tracked-
 * builder team (up to 50, most recently tracked, candidate excluded). Nothing
 * is persisted — the result is ephemeral, computed per request, with a short
 * Redis cache keyed on the canonical input (which embeds the team aggregate,
 * so a track/untrack naturally misses the cache — see synergy.ts's header).
 *
 * Response ladder (never a dead button):
 *  - team of < 2 (excluding the candidate)  → 200 { teamTooSmall: true } — no budget spent
 *  - allowance is 0 for this plan tier      → 429 { error: 'plan' } — hard gate, upgrade prompt
 *  - kill switch / no API key / daily cap / abuse rate limit / AI failure →
 *      200 { baseline, teamSize, degraded: true } — the deterministic rung-2 fallback
 *  - otherwise                              → 200 { analysis, baseline, teamSize, cached }
 */
import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import {
  findOrganizationBuilderByIdentity,
  listOrganizationBuildersForTeamAggregate,
} from '~/shared/lib/repositories/organization-builders'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { checkAndConsumeBudget } from '~/shared/lib/ai/budget'
import { getCached, setCached } from '~/shared/lib/ai/cache'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import { getTask } from '~/shared/lib/ai/tasks'
import { AIDisabledError, AIParseError, AIProviderError } from '~/shared/lib/ai/errors'
import { rateLimit } from '~/shared/lib/rate-limit'
import { env } from '~/shared/lib/env'
import {
  buildTeamAggregate,
  computeSynergyBaseline,
  codeStyleFingerprintV2Schema,
  synergyEnrichmentSchema,
  type CodeStyleMetrics,
  type SynergyInput,
  type TeamMemberRow,
} from '~/shared/lib/synergy'
import { generateFingerprint } from '~/shared/lib/code-style'

function toMetrics(fp: ReturnType<typeof generateFingerprint>): CodeStyleMetrics {
  return {
    paradigm: fp.paradigm,
    modularityScore: fp.modularityScore,
    testIntensity: fp.testIntensity,
    documentationRatio: fp.documentationRatio,
    complexityControl: fp.complexityControl,
    namingConsistency: fp.namingConsistency,
  }
}

const TEAM_FETCH_LIMIT = 51 // one extra slot in case the candidate is itself tracked

function errorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error(fallbackMessage, error)
  return Response.json({ error: fallbackMessage }, { status: 500 })
}

export const Route = createFileRoute('/api/builders/$builderId/synergy')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          const candidate = await withTenantContext(principal, (tx) =>
            findOrganizationBuilderByIdentity(tx, principal.organizationId, params.builderId),
          )
          if (!candidate) return Response.json({ error: 'Builder not found' }, { status: 404 })

          const teamRows = await withTenantContext(principal, (tx) =>
            listOrganizationBuildersForTeamAggregate(tx, principal.organizationId, TEAM_FETCH_LIMIT),
          )
          const teammates: TeamMemberRow[] = teamRows
            .filter((row) => row.identityId !== params.builderId)
            .slice(0, 50)

          if (teammates.length < 2) {
            return Response.json({ teamTooSmall: true })
          }

          const team = buildTeamAggregate(teammates)

          const candidatePrivateMetadata = (candidate.privateMetadata as Record<string, unknown>) ?? {}
          const storedFingerprint = codeStyleFingerprintV2Schema.safeParse(candidatePrivateMetadata.codeStyleFingerprint)
          const candidateTopics = Array.isArray(candidatePrivateMetadata.topics)
            ? (candidatePrivateMetadata.topics as string[])
            : []
          const fingerprint = storedFingerprint.success
            ? storedFingerprint.data.metrics
            : toMetrics(generateFingerprint({
                language: candidate.language,
                topics: candidateTopics,
                followersCount: candidate.followersCount ?? undefined,
              }))
          const fingerprintSource: 'ai' | 'heuristic' = storedFingerprint.success ? 'ai' : 'heuristic'

          const baseline = computeSynergyBaseline(
            { language: candidate.language, topics: candidateTopics, fingerprint },
            team,
          )

          const enrichmentParsed = synergyEnrichmentSchema.safeParse(candidatePrivateMetadata.aiEnrichment)

          const input: SynergyInput = {
            candidate: {
              username: candidate.username,
              source: candidate.source,
              bio: candidate.bio,
              topics: candidateTopics,
              language: candidate.language,
              followersCount: candidate.followersCount,
              fingerprint,
              fingerprintSource,
              enrichment: enrichmentParsed.success ? enrichmentParsed.data : null,
            },
            team: {
              size: team.size,
              languages: team.languages,
              topTopics: team.topTopics,
              paradigms: {
                functional: team.paradigms.functional ?? 0,
                oop: team.paradigms.oop ?? 0,
                pragmatic: team.paradigms.pragmatic ?? 0,
              },
              metricMeans: team.metricMeans,
              seniorityMix: team.seniorityMix,
              aiFingerprintShare: team.aiFingerprintShare,
            },
            baseline,
          }

          const teamSize = teammates.length

          const task = getTask('synergy-analysis')
          const entitlement = await withTenantContext(principal, (tx) =>
            getOrganizationEntitlement(tx, principal.organizationId),
          )

          if (task) {
            const budget = await checkAndConsumeBudget(principal, entitlement, task)
            if (!budget.allowed && budget.reason === 'plan') {
              return Response.json({ error: 'plan' }, { status: 429 })
            }

            if (env.AI_DISABLED !== 'true' && env.MINIMAX_API_KEY && budget.allowed) {
              const limit = await rateLimit('synergy', principal.userId, 10, 3600)
              if (limit.allowed) {
                try {
                  const cached = await getCached<unknown>(task, input)
                  const analysis = cached ?? await minimaxChat({
                    system: task.system,
                    prompt: task.buildPrompt(input),
                    schema: task.outputSchema,
                    maxOutputTokens: task.maxOutputTokens,
                  })
                  if (!cached) await setCached(task, input, analysis)
                  return Response.json({ analysis, baseline, teamSize, cached: Boolean(cached) })
                } catch (error) {
                  if (error instanceof AIParseError || error instanceof AIProviderError || error instanceof AIDisabledError) {
                    return Response.json({ baseline, teamSize, degraded: true })
                  }
                  throw error
                }
              }
            }
          }

          // Kill switch, missing key, budget exhausted (reason: 'budget'), no
          // registered task, or the abuse rate limit — every one of these is
          // a graceful degrade to the free, deterministic baseline rung, not
          // an error. Only the hard `plan` gate above returns non-200.
          return Response.json({ baseline, teamSize, degraded: true })
        } catch (error) {
          return errorResponse(error, 'Failed to analyze team fit')
        }
      },
    },
  },
})
