import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { runSprintsWorker } from '~/lib/sprints/worker'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

/**
 * Manually (or via external scheduler) runs the ai-sourcing-sprints worker.
 * Point an external scheduler (systemd timer, Coolify scheduled task, or a
 * plain `curl -X POST` in a crontab authenticated as an admin) at this
 * endpoint every 30 minutes, matching the plan's cadence. Never accepts a
 * caller-selected organization/sprint id — the worker always walks every
 * organization's own oldest-due active sprint (see lib/sprints/worker.ts).
 */
export const Route = createFileRoute('/api/admin/sprints/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const result = await runSprintsWorker()
          return Response.json({ ok: true, ...result })
        } catch (err) {
          console.error('sprints run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
