import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { runStatusChecks } from '~/shared/lib/status'

/**
 * The degradation signal a browser can poll (plan 57, Wave 5 — "Add contextual service degradation only").
 *
 * ## Why this exists next to `/api/status` rather than replacing it
 *
 * `/api/status` answers **503** when a dependency is degraded, which is correct and must not change: a monitor
 * decides on the status code, and a health endpoint that answers 200 while the database is down is a health
 * endpoint that never pages anyone.
 *
 * That contract makes it unusable from the app. A browser writes every non-2xx subresource to the console, so
 * polling `/api/status` from the dashboard put two console errors on every load *during an incident* — which is
 * exactly when an operator is reading the console — and the sign-in e2e's strict collector caught it. The task
 * was built and reverted on 2026-08-06 for that reason, and recorded as blocked on "a 200-answering degradation
 * signal".
 *
 * So the two consumers get two contracts over one computation. The status code here is always 200; the state is
 * in the body. `/api/health` cannot serve this either — it is a liveness probe that deliberately touches no
 * dependency, so it cannot know.
 *
 * ## What it deliberately does not return
 *
 * No uptime history, no timestamps beyond the read, no error strings from a failing check. A dashboard notice
 * needs one boolean and the names of what is affected; the numbers and the history live on `/status`, which is
 * the page the notice links to. Returning a driver's error text here would put an internal message on a tenant's
 * screen — and `runStatusChecks` results are shaped for an operator page, not a public one.
 *
 * It is public and unauthenticated for the same reason `/status` is: during an incident the people who most need
 * to know whether it is them or us are the ones who cannot sign in. It carries only component names and booleans,
 * which is what makes that safe.
 */
export const Route = createFileRoute('/api/status/summary')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async () => {
        /**
         * A failure to *read* the checks is reported as unknown, not as degraded.
         *
         * "We could not tell" and "something is broken" are different sentences, and showing an incident banner
         * because the check itself threw would train users to ignore the banner. Unknown renders nothing.
         */
        const checks = await runStatusChecks().catch(() => null)
        if (!checks) {
          return Response.json({ state: 'unknown' as const, degraded: [] }, { status: 200 })
        }

        const [db, redis, memory] = checks
        const named = [
          { name: 'database', ok: db.ok },
          { name: 'cache', ok: redis.ok },
          { name: 'memory', ok: memory.ok },
        ]
        const degraded = named.filter((component) => !component.ok).map((component) => component.name)

        return Response.json(
          {
            state: degraded.length === 0 ? ('ok' as const) : ('degraded' as const),
            /** Component names only — never a check's error text, which is written for an operator. */
            degraded,
          },
          {
            // Always 200. See the header: this is the half of the split that a browser can poll.
            status: 200,
            /**
             * Cached for thirty seconds at the edge and in the browser.
             *
             * The checks touch the database and Redis, and this endpoint is public and unauthenticated — so
             * without a cache header a page refresh loop becomes a dependency probe loop. Thirty seconds is
             * shorter than any incident anyone can act on and long enough that a crawler cannot turn it into
             * load.
             */
            headers: { 'cache-control': 'public, max-age=30' },
          },
        )
      },
    },
  },
})
