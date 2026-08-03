import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
  requireRecentPlatformAdminAuthentication,
} from '~/shared/lib/auth/platform-admin'
import { CRON_PRINCIPAL_USER_ID, tryCronPrincipal } from '~/shared/lib/auth/cron'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { runReconciliation, type ReconciliationCursor } from '~/shared/lib/billing/reconciliation'
import { findRunningJobRun, withJobRun } from '~/shared/lib/repositories/platform-operations'

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
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)
          requireRecentPlatformAdminAuthentication(principal)

          // The manual-run dispatcher (`operations/$jobKey/run.ts`) already guards this same
          // `billing.reconcile` job key against a concurrent duplicate — this bespoke route is a
          // second entry point to the identical job, so it needs the identical guard.
          const running = await findRunningJobRun('billing.reconcile')
          if (running) {
            return Response.json({ error: 'already_running', startedAt: running.startedAt?.toISOString() ?? null }, { status: 409 })
          }

          const body = await request.json().catch(() => ({}))
          const resumeFrom: ReconciliationCursor | null = body && typeof body === 'object' && body.resumeFrom
            ? { objectType: body.resumeFrom.objectType }
            : null

          // `billing_reconciliation_runs.actor_user_id` has a real FK to auth_users — the
          // synthetic cron principal's userId isn't a row there, so a cron-triggered run is
          // recorded as unattended (null) rather than violating that constraint.
          const actorUserId = principal.userId === CRON_PRINCIPAL_USER_ID ? null : principal.userId
          const { payload: summary } = await withJobRun({ jobKey: 'billing.reconcile' }, async () => {
            const result = await runReconciliation({ provider: getBillingProvider(), actorUserId, resumeFrom })
            const processedCount = Object.values(result.countsChecked).reduce((sum, n) => sum + n, 0)
            // "repairs_applied" means every mismatch found was auto-corrected — an operational
            // success, not a failure. Only unresolved mismatches ("mismatches_found") count as failed.
            const failedCount = result.result === 'mismatches_found' ? result.mismatches.length : 0
            return { processedCount, failedCount, errorCode: failedCount > 0 ? 'mismatches_found' : null, payload: result }
          })

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
