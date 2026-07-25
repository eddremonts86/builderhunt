/**
 * Work-Sample Analysis API (plan: work-sample).
 *
 * POST analyzes a public GitHub URL (repo/PR/file) and persists the result
 * as the recruiter's own artifact — see `work_sample_analyses`'s schema
 * comment for the privacy rationale (never the builder's profile data).
 *
 * Response ladder:
 *  - unparseable URL              → 400 { error: 'unsupported_url' }
 *  - no MINIMAX_API_KEY/GITHUB_TOKEN or kill switch → 503 { error: 'unavailable' }
 *  - fresh existing row, no force → 200 { analysis, cached: true } — no budget spent
 *  - allowance is 0 for this tier  → 429 { error: 'plan' }
 *  - daily budget exhausted        → 429 { error: 'budget' }
 *  - abuse rate limit hit          → 429 { error: 'rate_limited' }
 *  - sample not found/private      → 404 { error: 'sample_not_found' }
 *  - GitHub fetch failure          → 502 { error: 'github_error' }
 *  - AI parse/provider failure     → 502 { error: 'analysis_failed' }
 *  - otherwise                     → 200 { analysis, cached: false }
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { randomId } from '~/lib/utils'
import { env } from '~/shared/lib/env'
import { rateLimit } from '~/shared/lib/rate-limit'
import { checkAndConsumeBudget } from '~/shared/lib/ai/budget'
import { getCached, setCached } from '~/shared/lib/ai/cache'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import { getTask } from '~/shared/lib/ai/tasks'
import { AIDisabledError, AIParseError, AIProviderError } from '~/shared/lib/ai/errors'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { findWorkSampleAnalysis, upsertWorkSampleAnalysis } from '~/shared/lib/repositories/work-samples'
import { computeContentHash, GitHubRateLimitedError, GitHubTokenMissingError, parseSampleUrl, SampleNotFoundError, fetchSampleContent } from '~/lib/github/work-sample'
import type { WorkSampleAnalysis, WorkSampleAnalyzeInput } from '~/shared/lib/work-sample'

const RequestBody = z.object({
  url: z.string().min(1),
  builderId: z.string().min(1).optional(),
  force: z.boolean().optional(),
})

const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function errorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error(fallbackMessage, error)
  return Response.json({ error: fallbackMessage }, { status: 500 })
}

export const Route = createFileRoute('/api/work-samples/analyze')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          const parsedBody = RequestBody.safeParse(await request.json().catch(() => ({})))
          if (!parsedBody.success) {
            return Response.json({ error: 'invalid_request' }, { status: 400 })
          }
          const { url, builderId, force } = parsedBody.data

          const parsed = parseSampleUrl(url)
          if (!parsed) {
            return Response.json({ error: 'unsupported_url' }, { status: 400 })
          }

          if (env.AI_DISABLED === 'true' || !env.MINIMAX_API_KEY || !env.GITHUB_TOKEN) {
            return Response.json({ error: 'unavailable' }, { status: 503 })
          }

          const existing = await withTenantContext(principal, (tx) =>
            findWorkSampleAnalysis(tx, principal.userId, url),
          )
          if (existing && !force) {
            const analyzedAt = new Date((existing.analysis as WorkSampleAnalysis).analyzedAt)
            if (Date.now() - analyzedAt.getTime() < FRESH_WINDOW_MS) {
              return Response.json({ analysis: existing.analysis, cached: true })
            }
          }

          const task = getTask('work-sample-analyze')
          if (!task) return Response.json({ error: 'unavailable' }, { status: 503 })

          const entitlement = await withTenantContext(principal, (tx) =>
            getOrganizationEntitlement(tx, principal.organizationId),
          )
          const budget = await checkAndConsumeBudget(principal, entitlement, task)
          if (!budget.allowed) {
            return Response.json({ error: budget.reason }, { status: 429 })
          }

          const limit = await rateLimit('work-sample', principal.userId, 3, 3600)
          if (!limit.allowed) {
            return Response.json(
              { error: 'rate_limited' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.resetMs / 1000)) } },
            )
          }

          let content
          try {
            content = await fetchSampleContent(parsed)
          } catch (error) {
            if (error instanceof SampleNotFoundError) {
              return Response.json({ error: 'sample_not_found' }, { status: 404 })
            }
            if (error instanceof GitHubRateLimitedError || error instanceof GitHubTokenMissingError) {
              return Response.json({ error: 'github_error' }, { status: 502 })
            }
            throw error
          }

          const input: WorkSampleAnalyzeInput = {
            sampleType: parsed.type,
            sampleUrl: url,
            builderUsername: null,
            content,
          }

          let reviewModel
          try {
            const cached = await getCached<unknown>(task, input)
            reviewModel = cached ?? await minimaxChat({
              system: task.system,
              prompt: task.buildPrompt(input),
              schema: task.outputSchema,
              maxOutputTokens: task.maxOutputTokens,
            })
            if (!cached) await setCached(task, input, reviewModel)
          } catch (error) {
            if (error instanceof AIParseError || error instanceof AIProviderError || error instanceof AIDisabledError) {
              return Response.json({ error: 'analysis_failed' }, { status: 502 })
            }
            throw error
          }

          const analysis: WorkSampleAnalysis = {
            ...(reviewModel as object as Omit<WorkSampleAnalysis, 'analyzedAt' | 'model' | 'contentHash' | 'version'>),
            analyzedAt: new Date().toISOString(),
            model: 'minimax',
            contentHash: computeContentHash(content),
            version: 1,
          }

          const row = await withTenantContext(principal, (tx) =>
            upsertWorkSampleAnalysis(tx, {
              id: existing?.id ?? randomId(),
              userId: principal.userId,
              builderIdentityId: builderId ?? existing?.builderIdentityId ?? null,
              sampleUrl: url,
              sampleType: parsed.type,
              analysis,
            }),
          )

          return Response.json({ analysis: row.analysis, cached: false })
        } catch (error) {
          return errorResponse(error, 'Failed to analyze work sample')
        }
      },
    },
  },
})
