/**
 * Authed, plan-gated, rate-limited, budgeted proxy to the shared AI layer.
 *
 * Pipeline (each step short-circuits with the listed response — see
 * plans/ai-expansion/spec.md "API routes"):
 *   1. Kill switch (AI_DISABLED / AI_DISABLED_TASKS)      -> 503 ai_disabled
 *   2. MINIMAX_API_KEY unset                              -> 503 ai_unconfigured
 *   3. Tenant principal required                          -> 401 / 403
 *   4. Unknown task / invalid input                       -> 400
 *   5. Abuse rate limit (30 req / 60s per org+user)        -> 429
 *   6. Daily budget (plan-tier allowance)                  -> 429 { error: 'plan' | 'budget' }
 *   7. Cache hit                                           -> 200 { output, cached: true }
 *   8. MiniMax call, validate, cache write                 -> 200 { output, cached: false }
 *      AIParseError after one retry                        -> 502 ai_parse_failed
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from '~/shared/lib/env'
import { rateLimit } from '~/shared/lib/rate-limit'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { getTask, isTaskDisabled } from '~/shared/lib/ai/tasks'
import { checkAndConsumeBudget } from '~/shared/lib/ai/budget'
import { getCached, setCached } from '~/shared/lib/ai/cache'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import { AIDisabledError, AIParseError, AIProviderError } from '~/shared/lib/ai/errors'

interface CompleteRequestBody {
  taskId?: unknown
  input?: unknown
}

export const Route = createFileRoute('/api/ai/complete')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: CompleteRequestBody
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'invalid_json' }, { status: 400 })
        }

        const taskId = typeof body.taskId === 'string' ? body.taskId : ''

        // 1. Kill switch
        if (env.AI_DISABLED === 'true' || isTaskDisabled(taskId, env)) {
          return Response.json({ error: 'ai_disabled' }, { status: 503 })
        }

        // 2. Provider not configured
        if (!env.MINIMAX_API_KEY) {
          return Response.json({ error: 'ai_unconfigured' }, { status: 503 })
        }

        try {
          // 3. Tenant principal
          const principal = await requireTenantPrincipal(request)

          // 4. Unknown task / invalid input
          const task = getTask(taskId)
          if (!task) return Response.json({ error: 'unknown_task' }, { status: 400 })
          const parsedInput = task.inputSchema.safeParse(body.input)
          if (!parsedInput.success) return Response.json({ error: 'invalid_input' }, { status: 400 })

          // 5. Abuse rate limit
          const limit = await rateLimit('ai-complete', `${principal.organizationId}:${principal.userId}`, 30, 60)
          if (!limit.allowed) return Response.json({ error: 'rate_limited' }, { status: 429 })

          // 6. Daily budget (plan-tier allowance)
          const entitlement = await withTenantContext(principal, (tx) =>
            getOrganizationEntitlement(tx, principal.organizationId),
          )
          const budget = await checkAndConsumeBudget(principal, entitlement, task)
          if (!budget.allowed) {
            return Response.json(
              { error: budget.reason ?? 'budget', used: budget.used, limit: budget.limit },
              { status: 429 },
            )
          }

          // 7. Cache hit
          if (task.cacheTtlSeconds !== null) {
            const cached = await getCached(task, parsedInput.data)
            if (cached !== null) return Response.json({ output: cached, cached: true })
          }

          // 8. Provider call, validate, cache write
          const output = await minimaxChat({
            system: task.system,
            prompt: task.buildPrompt(parsedInput.data),
            schema: task.outputSchema,
            maxOutputTokens: task.maxOutputTokens,
          })
          await setCached(task, parsedInput.data, output)
          return Response.json({ output, cached: false })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof AIParseError) {
            return Response.json({ error: 'ai_parse_failed' }, { status: 502 })
          }
          if (error instanceof AIDisabledError) {
            return Response.json({ error: 'ai_unconfigured' }, { status: 503 })
          }
          if (error instanceof AIProviderError) {
            return Response.json({ error: 'ai_provider_error' }, { status: 502 })
          }
          console.error('AI complete error:', error)
          return Response.json({ error: 'internal_error' }, { status: 500 })
        }
      },
    },
  },
})
