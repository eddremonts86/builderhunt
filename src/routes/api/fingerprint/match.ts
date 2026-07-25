/**
 * Style matching (plan: code-fingerprinting Phase 4).
 *
 * POST a single source file; the server fingerprints it with the same
 * `fingerprint-v2` task and ranks the caller's *own* tracked builders by the
 * pure `similarity()` from `code-style.ts`.
 *
 * Scope is deliberately the caller's tracked builders, not a global search:
 * `organization_builders` is per-tenant, so a cross-user "find anyone who
 * writes like this" query has nothing to search. `eligibleCount` is returned
 * on every response — including the failures — so the UI can explain *why*
 * matching is unavailable ("analyze more builders first") rather than showing
 * an empty list.
 */
import { createFileRoute } from '@tanstack/react-router'
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
import { listOrganizationBuildersForTeamAggregate } from '~/shared/lib/repositories/organization-builders'
import {
  codeStyleFingerprintV2Schema,
  fingerprintFromV2,
  similarity,
  type CodeStyleFingerprint,
} from '~/shared/lib/code-style'
import { commentDensity } from '~/lib/github/content'

const RequestBody = z.object({
  content: z.string().min(1).max(100_000),
  filename: z.string().min(1).max(256).optional(),
})

/** Matching only becomes meaningful with a real corpus behind it. */
export const MATCH_DENSITY_THRESHOLD = 20
const CANDIDATE_FETCH_LIMIT = 200
const TOP_MATCHES = 15

interface Candidate {
  builderId: string
  username: string
  fingerprint: CodeStyleFingerprint
}

/** Loads the caller's tracked builders that carry a valid v2 envelope. */
async function loadCandidates(principal: Awaited<ReturnType<typeof requireTenantPrincipal>>): Promise<Candidate[]> {
  const rows = await withTenantContext(principal, (tx) =>
    listOrganizationBuildersForTeamAggregate(tx, principal.organizationId, CANDIDATE_FETCH_LIMIT),
  )
  const candidates: Candidate[] = []
  for (const row of rows) {
    const stored = codeStyleFingerprintV2Schema.safeParse(
      (row.privateMetadata as Record<string, unknown> | undefined)?.codeStyleFingerprint,
    )
    if (!stored.success) continue
    candidates.push({
      builderId: row.identityId,
      username: row.username,
      fingerprint: fingerprintFromV2(stored.data),
    })
  }
  return candidates
}

export const Route = createFileRoute('/api/fingerprint/match')({
  component: () => null,
  server: {
    handlers: {
      /**
       * Density probe. Exists because the panel needs to know whether to
       * render its input at all, and POST cannot answer that cheaply: it
       * validates the body first, so an empty probe body would 400 with a
       * meaningless count and a user with 19 fingerprints would be told
       * "0 of 20".
       */
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const candidates = await loadCandidates(principal)
          return Response.json({ eligibleCount: candidates.length, threshold: MATCH_DENSITY_THRESHOLD })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Fingerprint density probe error:', error)
          return Response.json({ error: 'Failed to read density' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = RequestBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_request', eligibleCount: 0 }, { status: 400 })
          }

          const candidates = await loadCandidates(principal)
          const eligibleCount = candidates.length

          if (eligibleCount < MATCH_DENSITY_THRESHOLD) {
            return Response.json({ error: 'insufficient_density', eligibleCount, matches: [] }, { status: 200 })
          }

          if (env.AI_DISABLED === 'true' || !env.MINIMAX_API_KEY) {
            return Response.json({ error: 'unavailable', eligibleCount }, { status: 503 })
          }
          const task = getTask('fingerprint-v2')
          if (!task) return Response.json({ error: 'unavailable', eligibleCount }, { status: 503 })

          const entitlement = await withTenantContext(principal, (tx) =>
            getOrganizationEntitlement(tx, principal.organizationId),
          )
          const budget = await checkAndConsumeBudget(principal, entitlement, task)
          if (!budget.allowed) {
            return Response.json({ error: budget.reason, eligibleCount }, { status: 429 })
          }

          const limit = await rateLimit('fingerprint', principal.userId, 5, 3600)
          if (!limit.allowed) {
            return Response.json({ error: 'rate_limited', eligibleCount }, { status: 429 })
          }

          const filename = parsed.data.filename ?? 'pasted-sample'
          // Same task, single-sample input: the pasted file is the whole
          // corpus, so the stats describe just it.
          const input = {
            username: `pasted:${filename}`,
            language: null,
            stats: {
              fileCount: 1,
              testFileRatio: 0,
              avgCommentDensity: commentDensity(parsed.data.content),
              repos: [],
            },
            samples: [{ repo: 'pasted', path: filename, content: parsed.data.content.slice(0, 20_000) }],
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
              return Response.json({ error: 'analysis_failed', eligibleCount }, { status: 502 })
            }
            throw error
          }

          const sampleFingerprint = fingerprintFromV2({
            ...(model as object as Parameters<typeof fingerprintFromV2>[0]),
            language: null,
            analyzedRepos: [],
            analyzedFiles: 1,
            analyzedAt: new Date().toISOString(),
            model: env.MINIMAX_MODEL ?? 'minimax',
            version: 2,
          })

          const matches = candidates
            .map((c) => ({ builderId: c.builderId, username: c.username, score: similarity(sampleFingerprint, c.fingerprint) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP_MATCHES)

          return Response.json({ matches, eligibleCount })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Fingerprint match error:', error)
          return Response.json({ error: 'Failed to match style' }, { status: 500 })
        }
      },
    },
  },
})
