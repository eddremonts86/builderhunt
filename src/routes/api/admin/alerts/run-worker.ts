import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runAlertsWorker } from '~/lib/alerts/worker'
import { withJobRun } from '~/shared/lib/repositories/platform-operations'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

/**
 * Manually (or via external scheduler) runs the smart-alerts worker.
 *
 * There's no OS-level cron in this bootstrap deployment (see
 * plans/phase-1/02-production-infrastructure/spec.md — "no paid services" v1). Point an
 * external scheduler (systemd timer, Coolify scheduled task, or a plain
 * `curl -X POST` in a crontab authenticated as an admin) at this endpoint
 * every 12 hours, matching the plan's cadence.
 */
export const Route = createFileRoute('/api/admin/alerts/run-worker')({
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
          // Every scheduled run gets exactly one `job_runs` row, closed even if the worker
          // throws (plan: calendar-scheduling-interview-intelligence, Phase 4). Counters are
          // mapped per worker rather than guessed generically, so the calendar feed's numbers
          // mean what its labels say. `payload` keeps the HTTP response shape unchanged.
          const { payload: result } = await withJobRun({ jobKey: 'alerts.evaluate' }, async () => {
            const outcome = await runAlertsWorker()
            return { processedCount: outcome.alertsEvaluated, failedCount: outcome.errors.length, payload: outcome }
          })
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
