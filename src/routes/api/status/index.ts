import { createFileRoute } from '@tanstack/react-router'
import { gte } from 'drizzle-orm'
import { db as publicDb } from '~/shared/lib/db/index'
import { statusChecks } from '~/shared/lib/db/schema'
import { computeUptime, runStatusChecks } from '~/shared/lib/status'

const UPTIME_WINDOW_DAYS = 30

export const Route = createFileRoute('/api/status/')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        const [[db, redis, memory], uptimeRows] = await Promise.all([
          runStatusChecks(),
          publicDb.select({ checkedAt: statusChecks.checkedAt, ok: statusChecks.ok }).from(statusChecks)
            .where(gte(statusChecks.checkedAt, new Date(Date.now() - UPTIME_WINDOW_DAYS * 24 * 60 * 60 * 1000)))
            .catch(() => []),
        ])
        const allOk = [db, redis, memory].every((c) => c.ok)
        const uptime30d = computeUptime(uptimeRows, UPTIME_WINDOW_DAYS)
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
