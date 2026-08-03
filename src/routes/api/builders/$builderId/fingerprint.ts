/**
 * Code-style fingerprint v2 (plan: code-fingerprinting).
 *
 * POST analyzes a tracked GitHub builder's real repository code and persists
 * the envelope at `organization_builders.privateMetadata.codeStyleFingerprint`
 * (the key `synergy.ts` reads; see `setOrganizationBuilderFingerprint` for why
 * it isn't `builders.metadata` as the spec's older text says).
 *
 * Response ladder — the v1 heuristic card stays visible behind every one of
 * these, so no branch leaves dead UI:
 *   non-GitHub source        → 400 { error: 'unsupported_source' }
 *   kill switch / no keys    → 503 { error: 'fingerprint_unavailable' }
 *   fresh envelope, no force → 200 { fingerprint, cached: true } (no budget spent)
 *   allowance 0 for the tier → 429 { error: 'plan' }
 *   daily budget exhausted   → 429 { error: 'budget' }
 *   abuse limiter            → 429 { error: 'rate_limited' }
 *   no usable source files   → 200 { insufficient: true } (nothing persisted)
 *   GitHub rate limit        → 503 { error: 'github_rate_limited' }
 *   model parse/provider     → 502 { error: 'analysis_failed' }
 *   otherwise                → 200 { fingerprint, cached: false }
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { rateLimit } from '~/shared/lib/rate-limit'
import { checkAndConsumeBudget } from '~/shared/lib/ai/budget'
import { getCached, setCached } from '~/shared/lib/ai/cache'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import { getTask } from '~/shared/lib/ai/tasks'
import { AIDisabledError, AIParseError, AIProviderError } from '~/shared/lib/ai/errors'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import {
  findOrganizationBuilderByEitherId,
  setOrganizationBuilderFingerprint,
} from '~/shared/lib/repositories/organization-builders'
import { codeStyleFingerprintV2Schema, type CodeStyleFingerprintV2 } from '~/shared/lib/code-style'
import { fetchRepoSamples, GitHubRateLimitedError, GitHubTokenMissingError } from '~/lib/github/content'

const RequestBody = z.object({ force: z.boolean().optional() })

const FRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export const Route = createFileRoute('/api/builders/$builderId/fingerprint')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const body = RequestBody.safeParse(await request.json().catch(() => ({})))
          const force = body.success ? body.data.force === true : false

          const builder = await withTenantContext(principal, (tx) =>
            findOrganizationBuilderByEitherId(tx, principal.organizationId, params.builderId),
          )
          if (!builder) return Response.json({ error: 'Builder not found' }, { status: 404 })
          if (builder.source !== 'github') {
            return Response.json({ error: 'unsupported_source' }, { status: 400 })
          }

          // Freshness is checked before the kill switch on purpose: a stored
          // envelope is still worth serving when the provider is down.
          const stored = codeStyleFingerprintV2Schema.safeParse(
            (builder.privateMetadata as Record<string, unknown> | undefined)?.codeStyleFingerprint,
          )
          if (stored.success && !force) {
            const age = Date.now() - Date.parse(stored.data.analyzedAt)
            if (Number.isFinite(age) && age < FRESH_WINDOW_MS) {
              return Response.json({ fingerprint: stored.data, cached: true })
            }
          }

          if (env.AI_DISABLED === 'true' || !env.MINIMAX_API_KEY || !env.GITHUB_TOKEN) {
            return Response.json({ error: 'fingerprint_unavailable' }, { status: 503 })
          }

          const task = getTask('fingerprint-v2')
          if (!task) return Response.json({ error: 'fingerprint_unavailable' }, { status: 503 })

          const entitlement = await withTenantContext(principal, (tx) =>
            getOrganizationEntitlement(tx, principal.organizationId),
          )
          const budget = await checkAndConsumeBudget(principal, entitlement, task)
          if (!budget.allowed) return Response.json({ error: budget.reason }, { status: 429 })

          const limit = await rateLimit('fingerprint', principal.userId, 5, 3600)
          if (!limit.allowed) {
            return Response.json(
              { error: 'rate_limited' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.resetMs / 1000)) } },
            )
          }

          let fetched
          try {
            fetched = await fetchRepoSamples(builder.username, { maxRepos: 3, maxFiles: 8 })
          } catch (error) {
            if (error instanceof GitHubRateLimitedError) {
              return Response.json({ error: 'github_rate_limited' }, { status: 503 })
            }
            if (error instanceof GitHubTokenMissingError) {
              return Response.json({ error: 'fingerprint_unavailable' }, { status: 503 })
            }
            throw error
          }

          // Only-forks, empty, or all-vendored repos land here. Nothing is
          // persisted — the builder may push real code later, and the v1
          // heuristic card remains correct in the meantime.
          if (fetched.samples.length === 0) {
            return Response.json({ insufficient: true })
          }

          const input = {
            username: builder.username,
            language: fetched.language,
            stats: {
              fileCount: fetched.samples.length,
              testFileRatio: fetched.testFileRatio,
              avgCommentDensity: fetched.avgCommentDensity,
              repos: fetched.repos,
            },
            samples: fetched.samples,
          }

          let model
          try {
            const cached = await getCached<unknown>(task, input)
            model = cached ?? await minimaxChat({
              system: task.system,
              prompt: task.buildPrompt(input),
              schema: task.outputSchema,
              maxOutputTokens: task.maxOutputTokens,
            })
            if (!cached) await setCached(task, input, model)
          } catch (error) {
            if (error instanceof AIParseError || error instanceof AIProviderError || error instanceof AIDisabledError) {
              return Response.json({ error: 'analysis_failed' }, { status: 502 })
            }
            throw error
          }

          const fingerprint: CodeStyleFingerprintV2 = {
            ...(model as object as Omit<CodeStyleFingerprintV2, 'language' | 'analyzedRepos' | 'analyzedFiles' | 'analyzedAt' | 'model' | 'version'>),
            language: fetched.language,
            analyzedRepos: fetched.repos,
            analyzedFiles: fetched.samples.length,
            analyzedAt: new Date().toISOString(),
            model: env.MINIMAX_MODEL ?? 'minimax',
            version: 2,
          }

          await withTenantContext(principal, (tx) =>
            setOrganizationBuilderFingerprint(tx, principal.organizationId, builder.identityId, fingerprint),
          )

          return Response.json({ fingerprint, cached: false })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Fingerprint generation error:', error)
          return Response.json({ error: 'Failed to generate fingerprint' }, { status: 500 })
        }
      },
    },
  },
})
