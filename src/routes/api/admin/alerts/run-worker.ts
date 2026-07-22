import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { runAlertsWorker } from '~/lib/alerts/worker'

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
          const principal = await requirePlatformAdminPrincipal(request)
          const result = await runAlertsWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'alerts',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('alerts run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
