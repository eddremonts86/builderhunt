import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { getBillingWebhookEventDetail } from '~/shared/lib/repositories/billing-events'

/**
 * Redacted single-event detail — retry history (`attempts`, `nextAttemptAt`), a scrubbed error
 * preview, and whether replaying it now makes sense (`replayEligible`/`replayEligibilityReason`).
 * Never the raw stored error message or the encrypted payload; see `billing-events.ts`.
 */
export const Route = createFileRoute('/api/admin/billing/events/$eventId')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const detail = await getBillingWebhookEventDetail(params.eventId)
          if (!detail) return Response.json({ error: 'No webhook event found with that id' }, { status: 404 })

          await auditPlatformAdminAction(principal, {
            action: 'admin.billing.events.view',
            targetType: 'billing_webhook_event',
            targetId: params.eventId,
            result: 'allowed',
          })

          return Response.json(detail)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin billing event detail error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
