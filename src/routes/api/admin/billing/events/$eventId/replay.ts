import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
  requireRecentPlatformAdminAuthentication,
} from '~/shared/lib/auth/platform-admin'
import { createStripeEventRetriever, replayBillingWebhookEvent, ReplayError } from '~/shared/lib/billing/worker'

/**
 * Platform-admin-audited single-event replay (spec.md: "audit and replay one normalized event
 * idempotently"). Bypasses the claim/lease mechanism and re-processes the named row regardless of
 * its current status — safe to run on an already-`processed` or dead-lettered row, since
 * `processStripeWebhookEvent`'s own idempotency guarantees make replaying an already-applied event
 * a no-op rather than a double effect.
 */
export const Route = createFileRoute('/api/admin/billing/events/$eventId/replay')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          requireRecentPlatformAdminAuthentication(principal)
          const result = await replayBillingWebhookEvent(params.eventId, { retriever: createStripeEventRetriever() })
          await auditPlatformAdminAction(principal, {
            action: 'admin.billing.events.replay',
            targetType: 'billing_webhook_event',
            targetId: params.eventId,
            result: 'allowed',
            details: { outcome: result.result, stripeEventId: result.stripeEventId },
          })
          return Response.json(result)
        } catch (err) {
          if (err instanceof ReplayError) {
            return Response.json({ error: err.message, code: err.code }, { status: 404 })
          }
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('billing event replay error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
