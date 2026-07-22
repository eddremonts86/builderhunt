import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { processPendingDeletions } from '~/shared/lib/legal'

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
          const principal = await requirePlatformAdminPrincipal(request)
          const result = await processPendingDeletions()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'legal-deletions',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('legal run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
