import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { getBillingOperationsMetrics } from '~/shared/lib/billing/operations-metrics'

/**
 * Read-only aggregate metrics for the platform billing operations dashboard
 * (plans/phase-1/30-stripe-billing-platform/tasks.md §9 "Build platform billing operations dashboard").
 * Platform-admin only; returns nothing beyond aggregate counts (no per-organization detail, no raw
 * webhook payloads, no secrets — every field comes straight from `getBillingOperationsMetrics`,
 * which never reads anything encrypted/secret itself).
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
          return Response.json(metrics)
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
