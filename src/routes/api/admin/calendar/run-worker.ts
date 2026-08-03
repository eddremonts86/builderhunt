import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { env } from '~/shared/lib/env'
import { runRecurrenceWorker } from '~/lib/calendar/recurrence-worker'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

/**
 * Runs the calendar recurrence materialization worker (plan:
 * calendar-scheduling-interview-intelligence, Phase 3).
 *
 * Same authentication shape as the existing workers (`alerts/run-worker`, `billing/run-worker`):
 * a cron principal or a platform admin, never an ordinary session. There is no OS-level cron in
 * this deployment, so an external scheduler POSTs here.
 */
export const Route = createFileRoute('/api/admin/calendar/run-worker')({
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

          // The kill switch gates the worker too, not just the UI — with the feature off, no
          // background job should be writing calendar rows.
          if (env.CALENDAR_ENABLED === 'false') {
            return Response.json({ ok: false, skipped: 'calendar_disabled' }, { status: 503 })
          }

          const result = await runRecurrenceWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'calendar-recurrence',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('calendar run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
