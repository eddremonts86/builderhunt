import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { runSprintsWorker } from '~/lib/sprints/worker'

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
          const principal = await requirePlatformAdminPrincipal(request)
          const result = await runSprintsWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'sprints',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('sprints run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
