import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { runSelfManagedAttachmentScanWorker } from '~/lib/scheduling/document-worker'
import { runSelfManagedSemanticIndexWorker } from '~/lib/semantic/self-managed-reconcile-worker'
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

          /*
           * Both self-managed workers, in this order, behind one trigger.
           *
           * The scan is what turns an attachment `clean`, and a clean attachment's title and
           * description are part of the semantic document — running the index first would index
           * every profile one pass behind its own work samples. They keep separate job keys and
           * therefore separate `job_runs` histories, because "the scanner is failing" and "the
           * index is drifting" are different operational facts and a shared key would merge them
           * into one line nobody can read.
           */
          const result = await runSelfManagedAttachmentScanWorker()
          const semanticIndex = await runSelfManagedSemanticIndexWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'self-managed-attachments',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result, semanticIndex })
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
