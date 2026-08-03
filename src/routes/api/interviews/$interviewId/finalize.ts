import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { finalize } from '~/lib/interviews/report-service'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import { findSessionByEvent } from '~/shared/lib/repositories/interviews'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { assertJsonRequest, assertSameOrigin } from '~/shared/lib/security/same-origin'
// Never from './report': a route module importing another route module keeps that module's exports
// alive in the client bundle, which is how the postgres driver got there.
import { errorResponse, toReportDto } from '~/lib/interviews/report-http'

/**
 * Marks a report version final (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * ## Its own route, because it is its own decision
 *
 * Finalizing is not an edit with a different flag. It is the moment the record stops being provisional, and
 * after it the report cannot be changed — so it gets a URL a client has to mean to call, rather than a
 * field on a `PATCH` that a serialization bug could set.
 *
 * `expectedVersion` is required and unforgiving. A panel interviewing together will have two drafts in
 * flight, and finalizing the one you were not looking at would freeze the wrong record.
 */

const finalizeSchema = z.object({
  expectedVersion: z.number().int().positive(),
  /** Deliberate acknowledgement that this cannot be undone. */
  confirmFinal: z.literal(true),
}).strict()

const FINALIZE_LIMIT = 10
const FINALIZE_WINDOW_SECONDS = 60

export const Route = createFileRoute('/api/interviews/$interviewId/finalize')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          assertSameOrigin(request)
          assertJsonRequest(request)
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit('interview-finalize', principal.userId, FINALIZE_LIMIT, FINALIZE_WINDOW_SECONDS)
          if (!limit.allowed) return Response.json({ error: 'rate_limited' }, { status: 429 })

          const parsed = finalizeSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const report = await withTenantContext(principal, async (transaction) => {
            // Finalizing is a write, so the owner alone — membership in the organization is not a
            // relationship to this interview. `null` becomes the same 404 as a missing interview.
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return null
            if (!context.isOwner) return 'not_owner' as const
            const session = await findSessionByEvent(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
            })
            if (!session) return null
            return finalize(transaction, principal, {
              session,
              expectedVersion: parsed.data.expectedVersion,
            })
          })

          if (!report) return Response.json({ error: 'not_found' }, { status: 404 })
          if (report === 'not_owner') return Response.json({ error: 'not_owner' }, { status: 403 })

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'interview.report.finalize',
            targetType: 'calendar_event',
            targetId: params.interviewId,
            result: 'allowed',
            requestId: principal.requestId,
            // The version and the time. This is the audit line that matters most in the whole feature: it
            // records when an assessment of a person became the record, and by whom.
            details: { version: report.version, finalizedAt: report.finalizedAt?.toISOString() ?? null },
          }, consoleSecurityAuditSink)

          return Response.json({ report: toReportDto(report) })
        } catch (error) {
          return errorResponse(error, 'interview report finalize')
        }
      },
    },
  },
})
