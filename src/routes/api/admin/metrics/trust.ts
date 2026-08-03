/**
 * Admin-only bounded aggregate for the profile removal/suppression pipeline (plans/UI/tasks.md
 * Wave 5 "Render redacted removal operations metrics"). Returns counts, aging buckets, and a
 * small-cohort-suppressed source breakdown — never a `sourceId`, URL, requester identity, or any
 * other per-request field.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { getRemovalOperationsMetrics } from '~/shared/lib/repositories/profile-removal'

export const Route = createFileRoute('/api/admin/metrics/trust')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const metrics = await getRemovalOperationsMetrics()
          return Response.json(metrics)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('removal operations metrics fetch failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
