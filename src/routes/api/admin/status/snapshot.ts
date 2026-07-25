import { createFileRoute } from '@tanstack/react-router'
import { lt } from 'drizzle-orm'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { workerDb } from '~/shared/lib/db/worker-db'
import { statusChecks } from '~/shared/lib/db/schema'
import { runStatusChecks } from '~/shared/lib/status'
import { randomId } from '~/lib/utils'

const RETENTION_DAYS = 90

/**
 * Uptime-history snapshot (status-and-trust plan, Phase 1). Point an external scheduler (VPS
 * crontab, Coolify scheduled task) at this every 5 minutes — matches
 * `computeUptime`'s default `intervalMinutes`. Same admin/cron auth as every other
 * `/api/admin/*\/run-worker` endpoint (`src/routes/api/admin/alerts/run-worker.ts`): a valid
 * `CRON_SECRET` bearer/header token, or a real platform-admin session as a manual fallback.
 */
export const Route = createFileRoute('/api/admin/status/snapshot')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)

          const components = await runStatusChecks()
          const ok = components.every((c) => c.ok)
          await workerDb.insert(statusChecks).values({ id: randomId(), ok, components })

          const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
          const pruned = await workerDb.delete(statusChecks).where(lt(statusChecks.checkedAt, cutoff)).returning({ id: statusChecks.id })

          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'status-snapshot',
            result: 'allowed',
            details: { ok, pruned: pruned.length },
          })
          return Response.json({ ok: true, inserted: true, pruned: pruned.length })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('status snapshot error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
