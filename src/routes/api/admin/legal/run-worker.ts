import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { processPendingDeletions } from '~/shared/lib/legal'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

/**
 * Manually (or via external scheduler) runs the account-deletion purge worker —
 * same pattern as src/routes/api/admin/alerts/run-worker.ts. Finds every
 * `deletion_requests` row past its grace period, hard-deletes the subject, and
 * marks the row completed. Point a daily VPS cron (or admin click) at this
 * endpoint — see plans/legal-and-compliance/plan.md Phase 1.
 */
export const Route = createFileRoute('/api/admin/legal/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const result = await processPendingDeletions()
          return Response.json({ ok: true, ...result })
        } catch (err) {
          console.error('legal run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
