/**
 * Runs one conversion-event retention pass (plan: audit-conversion) —
 * deletes raw events older than 30 days. Same "no OS-level cron in this
 * bootstrap deployment, point an external scheduler at this endpoint"
 * pattern as api/admin/billing/reconcile.ts: a platform-admin session or the
 * shared CRON_SECRET can trigger it.
 */
import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runConversionEventRetention } from '~/shared/lib/conversion-retention'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

export const Route = createFileRoute('/api/admin/analytics/run-retention')({
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
          const result = await runConversionEventRetention()

          await auditPlatformAdminAction(principal, {
            action: 'admin.analytics.conversion_retention',
            targetType: 'conversion_events',
            targetId: 'retention_run',
            result: 'allowed',
            details: { deletedCount: result.deletedCount, retainDays: result.retainDays },
          })

          return Response.json(result)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('conversion retention run failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
