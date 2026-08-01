import { createFileRoute } from '@tanstack/react-router'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { calculateNextRun, OPERATIONAL_SCHEDULES } from '~/shared/lib/operational-schedules'
import { listLatestJobRuns, listScheduleRegistry } from '~/shared/lib/repositories/platform-operations'

/**
 * Redacted operations projection — one row per `OPERATIONAL_SCHEDULES` entry, joined with its most
 * recent `job_runs` record (plans/UI/tasks.md Wave 5 "Add a redacted operations projection API").
 *
 * Never returns payloads, source URLs, candidate data, headers, tokens, or stack traces — `job_runs`
 * itself only ever stores a short `errorCode`, so there is nothing sensitive to redact at this layer
 * beyond passing that code through as-is.
 */
export const Route = createFileRoute('/api/admin/operations/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          const now = new Date()
          const registry = await listScheduleRegistry()
          const byKey = new Map(registry.map((row) => [row.jobKey, row]))
          const latestRuns = await listLatestJobRuns(OPERATIONAL_SCHEDULES.map((s) => s.jobKey))

          const jobs = OPERATIONAL_SCHEDULES.map((definition) => {
            const row = byKey.get(definition.jobKey) ?? null
            const enabled = row?.enabled ?? true
            const nextRunAt = row?.nextRunAt ?? (enabled ? calculateNextRun(definition, now) : null)
            const lastRun = latestRuns.get(definition.jobKey) ?? null
            // Overdue: a schedule that should have fired but the worker never advanced it — the
            // same "next run in the past means nothing is executing" signal the calendar feed uses.
            const overdue = enabled && nextRunAt !== null && nextRunAt.getTime() <= now.getTime()
            // Stale: the last recorded run is older than twice the schedule's own interval, i.e. at
            // least one full cycle was silently skipped without ever failing loudly.
            const intervalMs = lastRun
              ? Math.max(calculateNextRun(definition, lastRun.scheduledFor).getTime() - lastRun.scheduledFor.getTime(), 60_000)
              : null
            const stale = enabled && lastRun !== null
              && now.getTime() - lastRun.scheduledFor.getTime() > (intervalMs ?? 0) * 2

            return {
              jobKey: definition.jobKey,
              label: definition.label,
              scope: definition.scope,
              cronExpression: definition.cronExpression,
              timezone: definition.timezone,
              enabled,
              // Absent until the registry has synced this key in at least once (`syncScheduleRegistry`
              // runs at boot) — the pause/resume mutation needs this for its optimistic-concurrency
              // check, so the UI must not offer that control until a real version exists.
              version: row?.version ?? null,
              nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
              overdue,
              stale,
              lastRun: lastRun && {
                state: lastRun.state,
                scheduledFor: lastRun.scheduledFor.toISOString(),
                startedAt: lastRun.startedAt ? lastRun.startedAt.toISOString() : null,
                finishedAt: lastRun.finishedAt ? lastRun.finishedAt.toISOString() : null,
                durationMs: lastRun.durationMs,
                processedCount: lastRun.processedCount,
                failedCount: lastRun.failedCount,
                errorCode: lastRun.errorCode,
              },
            }
          })

          return Response.json({ jobs, generatedAt: now.toISOString() })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin operations projection error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
