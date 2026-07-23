import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { createStripeEventRetriever, runBillingWorker } from '~/shared/lib/billing/worker'

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
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
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
