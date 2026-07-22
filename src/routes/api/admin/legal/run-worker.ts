import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { processPendingOrganizationDeletions } from '~/shared/lib/auth/organization-lifecycle'
import { processPendingDeletions } from '~/shared/lib/legal'

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
      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const [accounts, organizations] = await Promise.all([
            processPendingDeletions(),
            processPendingOrganizationDeletions(),
          ])
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
