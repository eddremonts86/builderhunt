/**
 * Runs one conversion-event retention pass (plan: audit-conversion) —
 * deletes raw events older than 30 days. Same "no OS-level cron in this
 * bootstrap deployment, point an external scheduler at this endpoint"
 * pattern as api/admin/billing/reconcile.ts: a platform-admin session or the
 * shared CRON_SECRET can trigger it.
 */
import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runConversionEventRetention } from '~/shared/lib/conversion-retention'

export const Route = createFileRoute('/api/admin/analytics/run-retention')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          const result = await runConversionEventRetention()

          await auditPlatformAdminAction(principal, {
            action: 'admin.analytics.conversion_retention',
            targetType: 'conversion_events',
            targetId: 'retention_run',
            result: 'allowed',
            details: { deletedCount: result.deletedCount, retainDays: result.retainDays },
          })

          return Response.json(result)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('conversion retention run failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
