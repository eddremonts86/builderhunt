import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { runEnrichmentWorker } from '~/lib/enrichment/worker'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

/**
 * Manually (or via external scheduler) runs the public-profile-enrichment
 * worker — same pattern as src/routes/api/admin/alerts/run-worker.ts. No
 * caller-selected organization, builder, or connector (spec §10): the worker
 * claims whatever is due, nothing more.
 */
export const Route = createFileRoute('/api/admin/enrichment/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const result = await runEnrichmentWorker()
          return Response.json({ ok: true, ...result })
        } catch (err) {
          console.error('enrichment run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
