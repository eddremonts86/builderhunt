import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { tryCronPrincipal } from '~/shared/lib/auth/cron'
import { env } from '~/shared/lib/env'
import { runDocumentWorker } from '~/lib/scheduling/document-worker'
import { methodNotAllowedAfter } from '~/shared/lib/http/method-not-allowed'

/**
 * Runs the candidate-document scan/extraction worker (plan:
 * calendar-scheduling-interview-intelligence, Phase 6).
 *
 * Same authentication shape as the existing workers (`calendar/run-worker`, `alerts/run-worker`): a
 * cron principal or a platform admin, never an ordinary session. There is no OS-level cron in this
 * deployment, so an external scheduler POSTs here.
 *
 * The kill switch gates the worker, not just the UI. With uploads off there is nothing legitimate
 * for a background job to be scanning, and running anyway would move objects and write rows for a
 * feature the operator has switched off.
 */
export const Route = createFileRoute('/api/admin/documents/run-worker')({
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

          if (env.CANDIDATE_UPLOADS_ENABLED !== 'true') {
            return Response.json({ ok: false, skipped: 'candidate_uploads_disabled' }, { status: 503 })
          }

          const result = await runDocumentWorker()
          await auditPlatformAdminAction(principal, {
            action: 'admin.worker.run',
            targetType: 'worker',
            targetId: 'interview-documents',
            result: 'allowed',
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          // Name only. A storage or scanner error message can carry a signed URL or an object key,
          // and this response is not the place to learn either.
          console.error('documents run-worker error:', (err as Error)?.name)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
