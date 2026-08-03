import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { runInterviewRetentionWorker } from '~/lib/interviews/retention-worker'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

/**
 * Runs the interview retention sweep (plan:
 * calendar-scheduling-interview-intelligence, Phase 11).
 *
 * Same authentication as the other workers: a cron principal or a platform admin, never an ordinary
 * session. There is no OS-level cron in this deployment, so an external scheduler POSTs here.
 *
 * ## No feature flag gates this one
 *
 * Every other worker route refuses to run when its feature switch is off, and that is right for them —
 * with uploads disabled there is nothing legitimate to scan. Retention is the opposite: an operator who
 * *switches the feature off* still owes every candidate the deletion they were promised, and a sweep that
 * stopped with the flag would silently retain documents forever. Turning a feature off must not turn its
 * obligations off.
 *
 * ## `dryRun` defaults to false but is the first thing anyone should run
 *
 * The response carries the same counts either way, so an operator can compare a rehearsal to the real pass.
 */

const requestSchema = z.object({
  dryRun: z.boolean().optional(),
  tenantLimit: z.number().int().positive().max(200).optional(),
  rowLimit: z.number().int().positive().max(5_000).optional(),
}).strict()

export const Route = createFileRoute('/api/admin/interviews/run-retention')({
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
          const parsed = requestSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const result = await runInterviewRetentionWorker({
            dryRun: parsed.data.dryRun,
            tenantLimit: parsed.data.tenantLimit,
            rowLimit: parsed.data.rowLimit,
          })

          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'interview-retention',
            result: 'allowed',
            // Counts and tenant ids only. A retention audit line that named a document or a candidate would
            // recreate, in the audit log, exactly the record the sweep just deleted.
            details: {
              dryRun: result.dryRun,
              tenants: result.tenants,
              objectsDeleted: result.objectsDeleted,
              objectsFailed: result.objectsFailed,
              reservationsReleased: result.reservationsReleased,
              rowsDeleted: Object.values(result.counts).reduce((total, count) => total + count, 0),
              failedTenants: result.failedTenants.length,
            },
          })

          // `ok` reports whether the pass actually kept its promise, and a pass in which every tenant
          // failed answers 500. This route returned `ok: true` with HTTP 200 and every count at zero
          // for a missing privilege on `privacy_consents` — one denied statement aborted each
          // tenant's transaction, so nothing was ever purged, and neither cron nor a person reading
          // the response had any way to notice.
          const everyTenantFailed = result.tenants > 0 && result.failedTenants.length === result.tenants
          return Response.json(
            { ok: result.failedTenants.length === 0, ...result },
            { status: everyTenantFailed ? 500 : 200 },
          )
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          // Name only. A storage error message can carry an object key, and a retention failure is the last
          // place to reveal one — the whole point of the pass is that the key stops existing.
          console.error('interview run-retention error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
