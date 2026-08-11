import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { evaluateBillingAlerts, getBillingOperationsMetrics } from '~/shared/lib/billing/operations-metrics'

/**
 * Read-only aggregate metrics for the platform billing operations dashboard
 * (plans/implemented/30-stripe-billing-platform/tasks.md §9 "Build platform billing operations dashboard").
 * Platform-admin only; returns nothing beyond aggregate counts (no per-organization detail, no raw
 * webhook payloads, no secrets — every field comes straight from `getBillingOperationsMetrics`,
 * which never reads anything encrypted/secret itself).
 *
 * ## `alerts` moved here from `/api/admin/metrics`
 *
 * §10 of that plan asked for "critical SLO alerts", and `evaluateBillingAlerts` computed them — into
 * a response field no page has ever rendered. `/admin/metrics` was the only caller and it does not
 * read its own `billing` block, so every alert this product can raise about money was being computed
 * on a 15-second timer and discarded. Alerts belong beside the numbers they are drawn from, which is
 * this endpoint and the operations console that reads it.
 *
 * Computed here rather than in the browser because a threshold is a policy decision. Two clients
 * applying their own `> 120` would drift the first time one is updated, and the one that drifts low
 * is silent about a real incident.
 */
export const Route = createFileRoute('/api/admin/billing/metrics')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const metrics = await getBillingOperationsMetrics()
          return Response.json({ ...metrics, alerts: evaluateBillingAlerts(metrics) })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin billing metrics error:', err)
          return Response.json({ error: 'Failed to load billing metrics' }, { status: 500 })
        }
      },
    },
  },
})
