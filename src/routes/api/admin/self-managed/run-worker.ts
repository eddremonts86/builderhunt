import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runSelfManagedAttachmentScanWorker } from '~/lib/scheduling/document-worker'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

/**
 * Runs the self-managed attachment scan worker (plan: phase-2/07-perfiles-autogestionados).
 *
 * Same authentication shape as the other worker triggers (`documents/run-worker`,
 * `calendar/run-worker`): a cron principal or a platform admin, never an ordinary session. There is
 * no OS-level cron in this deployment, so an external scheduler POSTs here.
 *
 * No kill switch yet, deliberately: the plan's rollout task owns the one server-side flag that will
 * gate every self-managed surface at once, and until it exists this route is reachable only by cron
 * and platform admins — a worker run against a feature with no public writes scans an empty queue.
 * The plan's later reconciliation task extends this same route's job, not a second one.
 */
export const Route = createFileRoute('/api/admin/self-managed/run-worker')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowedAfter({
        guard: (request) => tryCronPrincipal(request) ?? requirePlatformAdminPrincipal(request),
        onRefusal: platformAdminErrorResponse,
        allowed: ['POST'],
        reason: 'This endpoint runs work. POST to trigger it; there is nothing to read.',
      }),

      POST: async ({ request }) => {
        try {
          const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)

          const result = await runSelfManagedAttachmentScanWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'self-managed-attachments',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          // Name only. A storage or scanner error message can carry a signed URL or an object key,
          // and this response is not the place to learn either.
          console.error('self-managed run-worker error:', (err as Error)?.name)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
