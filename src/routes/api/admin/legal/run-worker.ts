import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { processPendingOrganizationDeletions } from '~/shared/lib/auth/organization-lifecycle'
import { processPendingDeletions } from '~/shared/lib/legal'
import { withJobRun } from '~/shared/lib/repositories/platform-operations'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

/**
 * Manually (or via external scheduler) runs both grace-period purge workers —
 * same pattern as src/routes/api/admin/alerts/run-worker.ts. Account deletion
 * (`deletion_requests`) and organization deletion
 * (`organization_deletion_requests`) are deliberately separate tables/status
 * machines (an organization's deletion affects every other member, not just
 * the requester), but there's no reason ops needs two separate cron entries
 * to sweep them — one daily VPS cron (or admin click) covers both.
 */
export const Route = createFileRoute('/api/admin/legal/run-worker')({
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
          const { payload: { accounts, organizations } } = await withJobRun({ jobKey: 'legal.retention' }, async () => {
            const [accountsResult, organizationsResult] = await Promise.all([
              processPendingDeletions(),
              processPendingOrganizationDeletions(),
            ])
            return {
              processedCount: accountsResult.processed + organizationsResult.processed,
              failedCount: accountsResult.errors + organizationsResult.errors,
              payload: { accounts: accountsResult, organizations: organizationsResult },
            }
          })
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'legal-deletions',
            result: 'allowed',
            details: { accounts, organizations },
          })
          return Response.json({ ok: true, accounts, organizations })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('legal run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
