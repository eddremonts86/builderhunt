import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runEmbeddingsWorker } from '~/lib/semantic/embed-worker'

/**
 * Manually (or via external scheduler) runs the semantic-search embeddings
 * worker — same pattern as `src/routes/api/admin/alerts/run-worker.ts`.
 * There's no OS-level cron in this bootstrap deployment; point an external
 * scheduler (systemd timer, Coolify scheduled task, or a plain
 * `curl -X POST` in a crontab authenticated as an admin) at this endpoint
 * every 5–15 minutes, matching the plan's cadence.
 */
export const Route = createFileRoute('/api/admin/embeddings/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          const result = await runEmbeddingsWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'embeddings',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('embeddings run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
