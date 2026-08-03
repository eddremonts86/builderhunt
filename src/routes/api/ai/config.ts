/**
 * Public-safe AI configuration for the client tier.
 *
 * No auth, no secrets — the client uses this to hide AI UI entirely
 * (degradation rung 4 from plans/phase-1/21-ai-expansion/spec.md) without needing to
 * probe /api/ai/complete first. Never leaks the MiniMax key or model IDs.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { env } from '~/shared/lib/env'

export const Route = createFileRoute('/api/ai/config')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: () => {
        const disabled = env.AI_DISABLED === 'true'
        const disabledTasks = env.AI_DISABLED_TASKS.split(',').map((entry) => entry.trim()).filter(Boolean)
        const serverAI = Boolean(env.MINIMAX_API_KEY) && !disabled

        return new Response(JSON.stringify({ disabled, disabledTasks, serverAI }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=60',
          },
        })
      },
    },
  },
})
