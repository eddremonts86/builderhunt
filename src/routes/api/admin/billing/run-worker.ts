import { createFileRoute } from '@tanstack/react-router'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
  requireRecentPlatformAdminAuthentication,
} from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { createStripeEventRetriever, runBillingWorker } from '~/shared/lib/billing/worker'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

/**
 * Manually (or via external scheduler) claims and processes pending/retryable
 * `billing_webhook_events` rows, plus sweeps expired credit grants — the same
 * "no OS-level cron in this bootstrap deployment" pattern as
 * `api/admin/alerts/run-worker.ts`: point an external scheduler at this
 * endpoint, authenticated as a platform admin.
 */
export const Route = createFileRoute('/api/admin/billing/run-worker')({
  component: () => null,
  server: {
    handlers: {
      /**
       * A `GET` here is a mistake — usually a browser or a monitor pointed at a POST-only trigger. Without an
       * explicit handler the framework answers **200 with an HTML page**, so a monitor would record the worker
       * as healthy while never having run it.
       *
       * Rejected *after* the guard, not before: a bare 405 to an anonymous caller would confirm this route
       * exists. See `methodNotAllowedAfter`.
       */
      GET: methodNotAllowedAfter({
        guard: (request) => tryCronPrincipal(request) ?? requirePlatformAdminPrincipal(request),
        onRefusal: platformAdminErrorResponse,
        allowed: ['POST'],
        reason: 'This endpoint runs work. POST to trigger it; there is nothing to read.',
      }),

      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          requireRecentPlatformAdminAuthentication(principal)
          const summary = await runBillingWorker({ retriever: createStripeEventRetriever(), provider: getBillingProvider() })
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'billing',
            result: 'allowed',
            details: {
              claimedEvents: summary.claimedEvents,
              processedEvents: summary.processedEvents,
              deferredEvents: summary.deferredEvents,
              deadLetteredEvents: summary.deadLetteredEvents,
              expiredGrants: summary.expiredGrants,
              annualGrantsIssued: summary.annualGrantsIssued,
              paymentBlocksApplied: summary.paymentBlocksApplied,
              autoRechargeTriggered: summary.autoRechargeTriggered,
              refundsProcessed: summary.refundsProcessed,
            },
          })
          return Response.json({
            ok: true,
            claimedEvents: summary.claimedEvents,
            processedEvents: summary.processedEvents,
            deferredEvents: summary.deferredEvents,
            retryScheduledEvents: summary.retryScheduledEvents,
            deadLetteredEvents: summary.deadLetteredEvents,
            expiredGrants: summary.expiredGrants,
            annualGrantsIssued: summary.annualGrantsIssued,
            paymentBlocksApplied: summary.paymentBlocksApplied,
            autoRechargeTriggered: summary.autoRechargeTriggered,
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('billing run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
