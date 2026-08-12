/**
 * Runs one service-metric retention pass (plan 57, Admin track) — deletes minute buckets past the
 * thirty-day horizon.
 *
 * Same shape as `analytics/run-retention.ts`, for the same reason: there is no OS-level cron in this
 * deployment, so an external scheduler POSTs here with `CRON_SECRET`, and a platform admin can trigger it
 * by hand. Read that file's header for the pattern.
 *
 * What is specific to this one is the role. `runServiceMetricRetention` writes through `workerDb`, the only
 * role granted DELETE on `service_metric_buckets` — the app role that writes the minutes cannot erase them.
 * So an application bug can lose a minute of history but cannot delete the history it is being measured
 * against, and this endpoint is the only path to a delete.
 */
import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runServiceMetricRetention } from '~/shared/lib/repositories/service-metrics'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

export const Route = createFileRoute('/api/admin/metrics/run-retention')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowedAfter({
        guard: (request) => tryCronPrincipal(request) ?? requirePlatformAdminPrincipal(request),
        onRefusal: platformAdminErrorResponse,
        allowed: ['POST'],
        reason: 'This endpoint runs work. POST to trigger it; there is nothing to read.',
      }),

      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          const result = await runServiceMetricRetention()

          /**
           * Audited on every run, including the ones that delete nothing.
           *
           * A retention pass is a deletion, and "how much history do we still have" is a question an
           * operator asks after the fact. An audit row only when something was removed would leave no trace
           * of a scheduler that ran daily and quietly removed nothing because the store was not being
           * written — which looks identical to healthy retention.
           */
          await auditPlatformAdminAction(principal, {
            action: 'admin.metrics.service_metric_retention',
            targetType: 'service_metric_buckets',
            targetId: 'retention_run',
            result: 'allowed',
            details: { deletedCount: result.deletedCount, retainDays: result.retainDays },
          })

          return Response.json(result)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('service metric retention run failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
