/**
 * Admin/worker-only batch embeddings.
 *
 * Platform-admin only, not a tenant principal — this is an operator surface
 * for embedding backfills and global-public indexing, not a per-tenant
 * feature endpoint. Callers that need tenant-scoped embeddings should import
 * `embedTexts` directly from server code already running inside a verified
 * tenant context rather than routing through this HTTP endpoint.
 */
import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { env } from '~/shared/lib/env'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { rateLimit } from '~/shared/lib/rate-limit'
import { embedTexts } from '~/shared/lib/ai/embeddings'
import { AIDimensionMismatchError, AIEmbeddingUnavailableError, AIProviderError } from '~/shared/lib/ai/errors'

const embedBodySchema = z.object({
  texts: z.array(z.string().max(8000)).min(1).max(64),
})

export const Route = createFileRoute('/api/ai/embed')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (env.AI_DISABLED === 'true') {
          return Response.json({ error: 'ai_disabled' }, { status: 503 })
        }
        if (!env.AI_EMBEDDING_URL || !env.AI_EMBEDDING_MODEL) {
          return Response.json({ error: 'ai_unconfigured' }, { status: 503 })
        }

        let principal
        try {
          principal = await requirePlatformAdminPrincipal(request)
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          throw error
        }

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'invalid_json' }, { status: 400 })
        }

        const parsed = embedBodySchema.safeParse(body)
        if (!parsed.success) return Response.json({ error: 'invalid_input' }, { status: 400 })

        const limit = await rateLimit('ai-embed', principal.userId, 20, 60)
        if (!limit.allowed) return Response.json({ error: 'rate_limited' }, { status: 429 })

        try {
          const embeddings = await embedTexts(parsed.data.texts)
          await auditPlatformAdminAction(principal, {
            action: 'admin.ai.embed',
            targetType: 'ai-embedding-batch',
            targetId: null,
            result: 'allowed',
            details: { count: parsed.data.texts.length },
          })
          return Response.json({ embeddings, dim: env.AI_EMBEDDING_DIM })
        } catch (error) {
          if (error instanceof AIEmbeddingUnavailableError) {
            return Response.json({ error: 'ai_unconfigured' }, { status: 503 })
          }
          if (error instanceof AIDimensionMismatchError) {
            return Response.json({ error: 'ai_dimension_mismatch' }, { status: 502 })
          }
          if (error instanceof AIProviderError) {
            return Response.json({ error: 'ai_provider_error' }, { status: 502 })
          }
          console.error('AI embed error:', error)
          return Response.json({ error: 'internal_error' }, { status: 500 })
        }
      },
    },
  },
})
