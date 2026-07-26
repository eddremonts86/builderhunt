import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runEnrichmentWorker } from '~/lib/enrichment/worker'
import { withJobRun } from '~/shared/lib/repositories/platform-operations'

/**
 * Manually (or via external scheduler) runs the public-profile-enrichment
 * worker — same pattern as src/routes/api/admin/alerts/run-worker.ts. No
 * caller-selected organization, builder, or connector (spec §10): the worker
 * claims whatever is due, nothing more.
 */
export const Route = createFileRoute('/api/admin/enrichment/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          // Every scheduled run gets exactly one `job_runs` row, closed even if the worker
          // throws (plan: calendar-scheduling-interview-intelligence, Phase 4). Counters are
          // mapped per worker rather than guessed generically, so the calendar feed's numbers
          // mean what its labels say. `payload` keeps the HTTP response shape unchanged.
          const { payload: result } = await withJobRun({ jobKey: 'enrichment.refresh' }, async () => {
            const outcome = await runEnrichmentWorker()
            return { processedCount: outcome.processed, failedCount: outcome.failed, payload: outcome }
          })
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'enrichment',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('enrichment run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
