import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runDevpostWorker } from '~/lib/devpost/worker'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

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
      /**
       * A `GET` here is a mistake — usually a browser or a monitor pointed at a POST-only trigger. Without an
       * explicit handler the framework answers **200 with an HTML page**, so a monitor would record the worker
       * as healthy while never having run it.
       *
       * Rejected *after* the guard, not before: a bare 405 to an anonymous caller would confirm this route
       * exists. See `methodNotAllowedAfter`.
       */
      GET: methodNotAllowedAfter({
        guard: (request) => tryCronPrincipal(request) ?? requirePlatformAdminPrincipal(request),
        onRefusal: platformAdminErrorResponse,
        allowed: ['POST'],
        reason: 'This endpoint runs work. POST to trigger it; there is nothing to read.',
      }),

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
