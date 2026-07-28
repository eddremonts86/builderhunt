import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { env } from '~/shared/lib/env'
import { runWebImportWorker } from '~/lib/scheduling/web-import-worker'

/**
 * Runs the candidate web-import worker (plan:
 * calendar-scheduling-interview-intelligence, Phase 6).
 *
 * Same authentication as every other worker route: a cron principal or a platform admin, never an
 * ordinary session. Separate from `run-worker` (documents) on purpose — this one makes outbound
 * requests to third-party sites, so an operator needs to be able to stop it without also stopping
 * virus scanning, which is the thing keeping infected uploads out of the clean prefix.
 */
export const Route = createFileRoute('/api/admin/documents/run-web-imports')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)

          if (env.CANDIDATE_UPLOADS_ENABLED !== 'true') {
            return Response.json({ ok: false, skipped: 'candidate_uploads_disabled' }, { status: 503 })
          }

          const result = await runWebImportWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'interviews-web-import',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          // Name only. A fetch error message can carry a full third-party URL.
          console.error('documents run-web-imports error:', (err as Error)?.name)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
