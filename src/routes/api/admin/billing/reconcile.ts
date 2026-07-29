import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { CRON_PRINCIPAL_USER_ID, tryCronPrincipal } from '~/shared/lib/auth/cron'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { runReconciliation, type ReconciliationCursor } from '~/shared/lib/billing/reconciliation'

/**
 * Manually (or via external scheduler) runs one daily-financial-reconciliation pass
 * (plans/phase-1/30-stripe-billing-platform/tasks.md §10 "Implement daily financial reconciliation") — same
 * "no OS-level cron in this bootstrap deployment, point an external scheduler at this endpoint"
 * pattern as `api/admin/billing/run-worker.ts`. Accepts an optional resume cursor in the body so a
 * run that hit its time budget mid-pass can be continued by the next scheduled invocation instead of
 * restarting from the first object type every time.
 */
export const Route = createFileRoute('/api/admin/billing/reconcile')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          const body = await request.json().catch(() => ({}))
          const resumeFrom: ReconciliationCursor | null = body && typeof body === 'object' && body.resumeFrom
            ? { objectType: body.resumeFrom.objectType }
            : null

          // `billing_reconciliation_runs.actor_user_id` has a real FK to auth_users — the
          // synthetic cron principal's userId isn't a row there, so a cron-triggered run is
          // recorded as unattended (null) rather than violating that constraint.
          const actorUserId = principal.userId === CRON_PRINCIPAL_USER_ID ? null : principal.userId
          const summary = await runReconciliation({ provider: getBillingProvider(), actorUserId, resumeFrom })

          await auditPlatformAdminAction(principal, {
            action: 'admin.billing.reconcile',
            targetType: 'billing_reconciliation_run',
            targetId: summary.id,
            result: 'allowed',
            details: {
              result: summary.result,
              countsChecked: summary.countsChecked,
              mismatchCount: summary.mismatches.length,
              repairCount: summary.repairs.length,
              resumeCursor: summary.resumeCursor,
            },
          })

          return Response.json(summary)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin billing reconcile error:', err)
          return Response.json({ error: 'Failed to run reconciliation' }, { status: 500 })
        }
      },
    },
  },
})
