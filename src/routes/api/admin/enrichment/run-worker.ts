import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { runEnrichmentWorker } from '~/lib/enrichment/worker'

/**
 * Manually (or via external scheduler) runs the public-profile-enrichment
 * worker — same pattern as src/routes/api/admin/alerts/run-worker.ts. No
 * caller-selected organization, builder, or connector (spec §10): the worker
 * claims whatever is due, nothing more.
 */
export const Route = createFileRoute('/api/admin/enrichment/run-worker')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const result = await runEnrichmentWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'enrichment',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('enrichment run-worker error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
