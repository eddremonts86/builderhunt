import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { runDiscoveryWorker } from '~/lib/discovery/worker'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

/**
 * Manually (or via external scheduler) runs the proactive-discovery worker.
 *
 * Point an external scheduler (systemd timer, Coolify scheduled task, or a
 * plain `curl -X POST` in a crontab authenticated as an admin) at this
 * endpoint every 15 minutes — same crontab as the alerts and embeddings
 * workers (see plans/proactive-discovery/spec.md §3).
 */
export const Route = createFileRoute('/api/admin/discovery/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const result = await runDiscoveryWorker()
          return Response.json({ ok: true, ...result })
        } catch (err) {
          // Postgres 42P01 = undefined_table — semantic-search's builder_embeddings
          // table doesn't exist yet (deploy-order mistake); fail loudly, not silently.
          const code = (err as { code?: string })?.code
          if (code === '42P01') {
            return Response.json({ error: 'embeddings_store_missing' }, { status: 503 })
          }
          console.error('discovery run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
