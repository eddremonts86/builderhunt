import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { count, gte, min, sql } from 'drizzle-orm'
import { db as publicDb } from '~/shared/lib/db/index'
import { statusChecks } from '~/shared/lib/db/schema'
import { computeUptimeFromAggregate, runStatusChecks } from '~/shared/lib/status'

const UPTIME_WINDOW_DAYS = 30

export const Route = createFileRoute('/api/status/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async () => {
        // Two aggregates rather than up to 8640 rows. This endpoint is public and unauthenticated,
        // the window is 30 days and the cron samples every 5 minutes, so the previous shape — select
        // every row, then `filter(ok).length` and `reduce` to a minimum in Node — paid the full
        // transfer cost of a month of samples on every request. See `computeUptimeFromAggregate` for
        // why a `LIMIT` was not an option: the sample count is the denominator, so capping it
        // publishes an outage that is not happening.
        const [[db, redis, memory], uptimeAggregate] = await Promise.all([
          runStatusChecks(),
          publicDb
            .select({
              oldest: min(statusChecks.checkedAt),
              okSamples: count(sql`case when ${statusChecks.ok} then 1 end`),
            })
            .from(statusChecks)
            .where(gte(statusChecks.checkedAt, new Date(Date.now() - UPTIME_WINDOW_DAYS * 24 * 60 * 60 * 1000)))
            .catch(() => []),
        ])
        const allOk = [db, redis, memory].every((c) => c.ok)
        const aggregate = uptimeAggregate[0]
        const uptime30d = computeUptimeFromAggregate(
          {
            // `min()` over an empty window is SQL NULL, which is the "no history" case.
            oldest: aggregate?.oldest ? new Date(aggregate.oldest) : null,
            okSamples: Number(aggregate?.okSamples ?? 0),
          },
          UPTIME_WINDOW_DAYS,
        )
        return Response.json(
          {
            status: allOk ? 'ok' : 'degraded',
            version: '1.0.0',
            uptime: process.uptime(),
            checks: { db, redis, memory },
            uptime30d,
            timestamp: new Date().toISOString(),
          },
          { status: allOk ? 200 : 503 },
        )
      },
    },
  },
})
