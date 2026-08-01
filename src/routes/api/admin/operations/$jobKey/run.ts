import { createFileRoute } from '@tanstack/react-router'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
  requireRecentPlatformAdminAuthentication,
} from '~/shared/lib/auth/platform-admin'
import { env } from '~/shared/lib/env'
import { findScheduleDefinition } from '~/shared/lib/operational-schedules'
import { findRunningJobRun, withJobRun } from '~/shared/lib/repositories/platform-operations'
import { runAlertsWorker } from '~/lib/alerts/worker'
import { runSprintsWorker } from '~/lib/sprints/worker'
import { runEnrichmentWorker } from '~/lib/enrichment/worker'
import { runDiscoveryWorker } from '~/lib/discovery/worker'
import { runEmbeddingsWorker } from '~/lib/semantic/embed-worker'
import { RECURRENCE_JOB_KEY, runRecurrenceWorker } from '~/lib/calendar/recurrence-worker'
import { REMINDER_JOB_KEY, runReminderWorker } from '~/lib/calendar/reminder-worker'
import { processPendingDeletions } from '~/shared/lib/legal'
import { processPendingOrganizationDeletions } from '~/shared/lib/auth/organization-lifecycle'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { runReconciliation } from '~/shared/lib/billing/reconciliation'
import { workerDb } from '~/shared/lib/db/worker-db'
import { statusChecks } from '~/shared/lib/db/schema'
import { runStatusChecks } from '~/shared/lib/status'
import { randomId } from '~/lib/utils'
import { lt } from 'drizzle-orm'

/**
 * Manual "run now" for a single scheduled job (plans/UI/tasks.md Wave 5 "Add allowlisted pause,
 * resume, and manual-run APIs") — the Admin Operations UI's single unified trigger button, covering
 * every entry in `OPERATIONAL_SCHEDULES`.
 *
 * This is deliberately separate from the per-worker `/api/admin/*\/run-worker` endpoints, which
 * stay in place for external-scheduler use (a VPS crontab authenticated with `CRON_SECRET`). Both
 * paths call the same worker functions, so a manual click here and a scheduled cron hit produce
 * identical `job_runs` history — there is no "manual" vs "scheduled" distinction in that table.
 *
 * Two of the ten jobs (calendar recurrence and reminder delivery) already wrap themselves in
 * `withJobRun` internally — see recurrence-worker.ts / reminder-worker.ts. Wrapping them again here
 * would record two `job_runs` rows for one actual run, so those two are dispatched directly.
 */

interface DispatchOutcome {
  processedCount: number
  failedCount: number
  errorCode?: string | null
  details: object
}

async function runWrapped(jobKey: string, operation: () => Promise<DispatchOutcome>): Promise<object> {
  const { payload } = await withJobRun({ jobKey }, async () => {
    const outcome = await operation()
    return { processedCount: outcome.processedCount, failedCount: outcome.failedCount, errorCode: outcome.errorCode ?? null, payload: outcome.details }
  })
  return payload
}

const DISPATCH_MAP: Record<string, (actorUserId: string) => Promise<object>> = {
  'alerts.evaluate': () => runWrapped('alerts.evaluate', async () => {
    const outcome = await runAlertsWorker()
    return { processedCount: outcome.alertsEvaluated, failedCount: outcome.errors.length, details: outcome }
  }),
  'sprints.execute': () => runWrapped('sprints.execute', async () => {
    const outcome = await runSprintsWorker()
    return { processedCount: outcome.sprintsRun, failedCount: outcome.errors.length, details: outcome }
  }),
  'enrichment.refresh': () => runWrapped('enrichment.refresh', async () => {
    const outcome = await runEnrichmentWorker()
    return { processedCount: outcome.processed, failedCount: outcome.failed, details: outcome }
  }),
  'discovery.crawl': () => runWrapped('discovery.crawl', async () => {
    const outcome = await runDiscoveryWorker()
    return { processedCount: outcome.upserted, failedCount: 0, details: outcome }
  }),
  'embeddings.backfill': () => runWrapped('embeddings.backfill', async () => {
    const outcome = await runEmbeddingsWorker()
    return { processedCount: outcome.embedded, failedCount: outcome.failed, details: outcome }
  }),
  'legal.retention': () => runWrapped('legal.retention', async () => {
    const [accounts, organizations] = await Promise.all([
      processPendingDeletions(),
      processPendingOrganizationDeletions(),
    ])
    return { processedCount: accounts.processed + organizations.processed, failedCount: accounts.errors + organizations.errors, details: { accounts, organizations } }
  }),
  'billing.reconcile': (actorUserId) => runWrapped('billing.reconcile', async (): Promise<DispatchOutcome> => {
    const result = await runReconciliation({ provider: getBillingProvider(), actorUserId, resumeFrom: null })
    const processedCount = Object.values(result.countsChecked).reduce((sum, n) => sum + n, 0)
    const failedCount = result.result === 'mismatches_found' ? result.mismatches.length : 0
    return { processedCount, failedCount, errorCode: failedCount > 0 ? 'mismatches_found' : null, details: result }
  }),
  'status.snapshot': () => runWrapped('status.snapshot', async () => {
    const components = await runStatusChecks()
    const failing = components.filter((c) => !c.ok)
    const ok = failing.length === 0
    await workerDb.insert(statusChecks).values({ id: randomId(), ok, components })
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    const pruned = await workerDb.delete(statusChecks).where(lt(statusChecks.checkedAt, cutoff)).returning({ id: statusChecks.id })
    return { processedCount: components.length, failedCount: failing.length, errorCode: failing.length > 0 ? 'status_check_failed' : null, details: { ok, pruned: pruned.length } }
  }),
  [RECURRENCE_JOB_KEY]: async () => {
    if (env.CALENDAR_ENABLED === 'false') return { skipped: 'calendar_disabled' }
    const result = await runRecurrenceWorker()
    return { ...result }
  },
  [REMINDER_JOB_KEY]: async () => {
    if (env.CALENDAR_ENABLED === 'false') return { skipped: 'calendar_disabled' }
    const result = await runReminderWorker()
    return { ...result }
  },
}

export const Route = createFileRoute('/api/admin/operations/$jobKey/run')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          requireRecentPlatformAdminAuthentication(principal)

          const definition = findScheduleDefinition(params.jobKey)
          if (!definition) return Response.json({ error: 'Unknown job key' }, { status: 404 })

          const running = await findRunningJobRun(definition.jobKey)
          if (running) {
            return Response.json({ error: 'already_running', startedAt: running.startedAt?.toISOString() ?? null }, { status: 409 })
          }

          const dispatch = DISPATCH_MAP[definition.jobKey]
          if (!dispatch) {
            // Every OPERATIONAL_SCHEDULES entry must have a dispatcher — this is a build-time
            // registry gap, not a request the caller could have avoided.
            console.error(`admin operations manual-run: no dispatcher registered for ${definition.jobKey}`)
            return Response.json({ error: 'not_implemented' }, { status: 501 })
          }

          const details = await dispatch(principal.userId)

          await auditPlatformAdminAction(principal, {
            action: 'admin.operations.run',
            targetType: 'operational_schedule',
            targetId: definition.jobKey,
            result: 'allowed',
          })

          return Response.json({ ok: true, jobKey: definition.jobKey, ...details })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin operations manual-run error:', err)
          const code = (err as { code?: string })?.code
          if (code === '42P01') return Response.json({ error: 'embeddings_store_missing' }, { status: 503 })
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
