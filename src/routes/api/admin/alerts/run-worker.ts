import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { runAlertsWorker } from '~/lib/alerts/worker'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

/**
 * Manually (or via external scheduler) runs the smart-alerts worker.
 *
 * There's no OS-level cron in this bootstrap deployment (see
 * plans/production-infrastructure/spec.md — "no paid services" v1). Point an
 * external scheduler (systemd timer, Coolify scheduled task, or a plain
 * `curl -X POST` in a crontab authenticated as an admin) at this endpoint
 * every 12 hours, matching the plan's cadence.
 */
export const Route = createFileRoute('/api/admin/alerts/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const result = await runAlertsWorker()
          return Response.json({ ok: true, ...result })
        } catch (err) {
          console.error('alerts run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
