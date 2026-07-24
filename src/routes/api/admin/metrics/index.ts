import { createFileRoute } from '@tanstack/react-router'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { evaluateBillingAlerts, getBillingOperationsMetrics } from '~/shared/lib/billing/operations-metrics'
import { metrics } from '~/shared/lib/metrics'
import { getPlatformAccountMetrics } from '~/shared/lib/repositories/platform-billing'
import { getDiscoveryState } from '~/shared/lib/repositories/discovery-state'

export const Route = createFileRoute('/api/admin/metrics/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          // In-process metrics
          const inProcess = metrics.get()

          // DB aggregates
          const now = new Date()
          const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

          const accountMetrics = await getPlatformAccountMetrics(oneDayAgo, oneWeekAgo)
          const discovery = await getDiscoveryState().catch(() => null)
          const billingMetrics = await getBillingOperationsMetrics()

          return Response.json({
            inProcess,
            db: {
              ...accountMetrics,
              totalSavedQueries: null,
              totalBuilders: null,
              totalNotes: null,
            },
            discovery: discovery && {
              cursor: discovery.cursor,
              lastCellKey: discovery.lastCellKey,
              lastRunAt: discovery.lastRunAt,
              stats: discovery.stats,
            },
            // plans/stripe-billing-platform/tasks.md §10 "Add financial notifications, metrics, and
            // alerts" — checkout/recovery/webhook-age/ledger-invariant/auto-recharge/cost-margin/
            // country-gate metrics, plus the critical SLO alerts computed from them.
            billing: { ...billingMetrics, alerts: evaluateBillingAlerts(billingMetrics) },
            server: {
              nodeVersion: process.version,
              platform: process.platform,
              pid: process.pid,
              memoryUsage: process.memoryUsage(),
            },
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin metrics error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
