/**
 * Health endpoint for Coolify and docker-compose healthchecks.
 *
 * Returns 200 with a small JSON body when the app process is responsive.
 * Does NOT touch the DB on purpose — DB liveness is checked by the `db`
 * service's own healthcheck. Mixing the two would cause cascading failures
 * during planned DB maintenance.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'

export const Route = createFileRoute('/api/health')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: () =>
        new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
  },
})
