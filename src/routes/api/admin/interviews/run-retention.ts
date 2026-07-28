import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { runInterviewRetentionWorker } from '~/lib/interviews/retention-worker'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'

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

          return Response.json({ ok: true, ...result })
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
