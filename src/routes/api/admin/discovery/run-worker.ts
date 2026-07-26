import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runDiscoveryWorker } from '~/lib/discovery/worker'
import { withJobRun } from '~/shared/lib/repositories/platform-operations'

/**
 * Manually (or via external scheduler) runs the proactive-discovery worker.
 *
 * Point an external scheduler (systemd timer, Coolify scheduled task, or a
 * plain `curl -X POST` in a crontab authenticated as an admin) at this
 * endpoint every 15 minutes — same crontab as the alerts and embeddings
 * workers (see plans/proactive-discovery/spec.md §3).
 */
export const Route = createFileRoute('/api/admin/discovery/run-worker')({
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
          const { payload: result } = await withJobRun({ jobKey: 'discovery.crawl' }, async () => {
            const outcome = await runDiscoveryWorker()
            return { processedCount: outcome.upserted, failedCount: 0, payload: outcome }
          })
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'discovery',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          // Postgres 42P01 = undefined_table — semantic-search's builder_embeddings
          // table doesn't exist yet (deploy-order mistake); fail loudly, not silently.
          const code = (err as { code?: string })?.code
          if (code === '42P01') {
            return Response.json({ error: 'embeddings_store_missing' }, { status: 503 })
          }
          console.error('discovery run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
