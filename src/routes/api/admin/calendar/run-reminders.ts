import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { env } from '~/shared/lib/env'
import { runReminderWorker } from '~/lib/calendar/reminder-worker'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

/**
 * Runs the calendar reminder delivery worker (plan:
 * calendar-scheduling-interview-intelligence, Phase 3).
 *
 * Same authentication shape as the other workers (`calendar/run-worker`, `alerts/run-worker`): a
 * cron principal or a platform admin, never an ordinary session. There is no OS-level cron in this
 * deployment, so an external scheduler POSTs here.
 */
export const Route = createFileRoute('/api/admin/calendar/run-reminders')({
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

          // The kill switch gates delivery too. With the feature off, no reminder email should
          // leave the system — a user who cannot see their calendar should not be mailed about it.
          if (env.CALENDAR_ENABLED === 'false') {
            return Response.json({ ok: false, skipped: 'calendar_disabled' }, { status: 503 })
          }

          const result = await runReminderWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'calendar-reminders',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('calendar run-reminders error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
