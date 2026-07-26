import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { assertRegistryIsSafe } from '~/shared/lib/operational-schedules'
import { listScheduleRegistry, syncScheduleRegistry } from '~/shared/lib/repositories/platform-operations'

/**
 * Reconciles the database schedule registry with the code registry (plan:
 * calendar-scheduling-interview-intelligence, Phase 4).
 *
 * Deliberately an explicit endpoint rather than something that runs on boot. Every app instance
 * boots, so a boot-time sync would have N instances racing to rewrite the same rows on every
 * deploy; and a registry that silently rewrites itself is harder to reason about than one an
 * operator (or the deploy pipeline) triggers on purpose and can see the result of.
 *
 * The registry's structural checks run first, so a bad entry is refused before it can be written.
 */
export const Route = createFileRoute('/api/admin/operations/sync-schedules')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          assertRegistryIsSafe()

          const result = await syncScheduleRegistry(new Date())
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'operations-sync-schedules',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('operations sync-schedules error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      GET: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          const schedules = await listScheduleRegistry()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'operations-list-schedules',
            result: 'allowed',
          })
          return Response.json({ schedules })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('operations list-schedules error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
