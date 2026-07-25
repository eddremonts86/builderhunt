import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runDevpostWorker } from '~/lib/devpost/worker'

/**
 * Manually (or via external scheduler) runs the Devpost ingestion worker.
 * Point an external scheduler (VPS crontab) at this endpoint — see
 * docs/operations/deploy-runbook.md's "Workers / scrapers" table. No-ops
 * (returns `{ disabled: true }`) unless `DEVPOST_ENABLED=true`.
 */
export const Route = createFileRoute('/api/admin/devpost/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          const result = await runDevpostWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'devpost',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('devpost run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
