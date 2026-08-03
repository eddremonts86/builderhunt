/**
 * Server-owned readiness for the Solutions product shell (plans/UI/tasks.md Wave 7 "Make
 * Solutions preview state honest and dependency-aware").
 *
 * No auth, no secrets — same pattern as `/api/ai/config`: a boolean the client uses to decide
 * whether it's allowed to describe the generation step as real (billed, saved) rather than a
 * labeled preview. `paidGenerationEnabled` is the one flag that gates the billed path
 * (`solutions.generate.v1`/`solutions.regenerate.v1`) — see `shared/lib/solutions/config.ts`.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getSolutionsFeatureFlags } from '~/shared/lib/solutions/config'

export const Route = createFileRoute('/api/solutions/config')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: () => {
        const ready = getSolutionsFeatureFlags().paidGenerationEnabled
        return new Response(JSON.stringify({ ready }), {
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
