/**
 * Runs one activity-feed retention pass (plan: activity-feed, task 6) —
 * deletes expired `organization_activity` rows in bounded batches. Same
 * "no OS-level cron in this bootstrap deployment, point an external
 * scheduler at this endpoint" pattern as api/admin/analytics/run-retention.ts:
 * a platform-admin session or the shared CRON_SECRET can trigger it.
 *
 * Found missing during the 2026-07-31 phase-1 audit: `runActivityRetention`
 * (src/shared/lib/workers/activity-retention.ts) was fully built and tested
 * in isolation, but no route ever called it — every activity row with a
 * retentionDays value was accumulating forever instead of expiring.
 */
import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runActivityRetention } from '~/shared/lib/workers/activity-retention'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

export const Route = createFileRoute('/api/admin/activity/run-retention')({
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
          const result = await runActivityRetention()

          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'activity-retention',
            result: 'allowed',
            details: {
              scannedBatches: result.scannedBatches,
              deleted: result.deleted,
              hitLimit: result.hitLimit,
            },
          })

          return Response.json(result)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('activity retention run failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
