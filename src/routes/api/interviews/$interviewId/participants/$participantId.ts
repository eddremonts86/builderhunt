import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { setParticipantMaterialAccess } from '~/shared/lib/repositories/calendar'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { assertJsonRequest, assertSameOrigin } from '~/shared/lib/security/same-origin'
// Outside `src/routes` on purpose — exporting a helper that reaches the server layer from a route
// module puts the postgres driver in the client bundle and kills every page.
import { errorResponse } from '~/lib/interviews/report-http'

/**
 * Grant or revoke one participant's access to an interview's material — the brief, the report, the
 * suggestions and the transcript.
 *
 * ## Why this route exists
 *
 * Until it did, there was no way to share interview material on purpose. `event_participants` carried
 * a single `access_granted` column that calendar code set for every internal attendee, and the
 * interview side read that same column as "was handed the candidate's material" — so inviting a
 * colleague to the meeting silently handed them the transcript. 0100 split the two columns and 0101
 * added the trigger that keeps the new one owner-only; this is the sanctioned way to write it, and
 * before it existed the only way was a direct SQL update.
 *
 * ## Refusals
 *
 * A caller with no relationship to the interview gets **404**, never 403: a 403 would confirm that an
 * interview exists at this id to someone who has no business knowing. A granted participant gets
 * **403**, because they can already read the material and answering 404 to someone who just fetched
 * the thing reads as a bug rather than a boundary. That is the same split the report and brief routes
 * use.
 *
 * Sharing is the owner's act alone. Notably an organization admin cannot do it either — administering
 * a tenant is not a relationship to a particular candidate's interview.
 */

const bodySchema = z.object({ materialAccessGranted: z.boolean() }).strict()

const GRANT_LIMIT = 20
const GRANT_WINDOW_SECONDS = 60

export const Route = createFileRoute('/api/interviews/$interviewId/participants/$participantId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH']),

      PATCH: async ({ request, params }) => {
        try {
          assertSameOrigin(request)
          assertJsonRequest(request)
          const principal = await requireTenantPrincipal(request)
          const limit = await rateLimit(
            'interview-material-grant',
            principal.userId,
            GRANT_LIMIT,
            GRANT_WINDOW_SECONDS,
          )
          if (!limit.allowed) {
            return Response.json({ error: 'rate_limited' }, {
              status: 429,
              headers: { 'retry-after': String(Math.ceil(limit.resetMs / 1000)) },
            })
          }

          const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const outcome = await withTenantContext(principal, async (transaction) => {
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return { kind: 'not_found' as const }
            if (!context.isOwner) return { kind: 'not_owner' as const }
            const participant = await setParticipantMaterialAccess(transaction, {
              organizationId: principal.organizationId,
              eventId: params.interviewId,
              ownerUserId: principal.userId,
              participantId: params.participantId,
              granted: parsed.data.materialAccessGranted,
            })
            // A participant id that does not belong to this interview is indistinguishable from one
            // that does not exist, on purpose.
            if (!participant) return { kind: 'not_found' as const }
            return { kind: 'ok' as const, participant }
          })

          if (outcome.kind === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
          if (outcome.kind === 'not_owner') return Response.json({ error: 'not_owner' }, { status: 403 })
          const { participant } = outcome

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'interview.material.access',
            targetType: 'event_participant',
            targetId: participant.id,
            result: 'allowed',
            requestId: principal.requestId,
            // Ids and the new state. Not the participant's email or display name, and nothing about
            // the candidate: an audit line recording who may read an interview is not the place to
            // name the person being interviewed.
            details: { eventId: params.interviewId, granted: parsed.data.materialAccessGranted },
          }, consoleSecurityAuditSink)

          return Response.json({
            participant: {
              id: participant.id,
              role: participant.role,
              response: participant.response,
              accessGranted: participant.accessGranted,
              materialAccessGranted: participant.materialAccessGranted,
            },
          })
        } catch (error) {
          return errorResponse(error, 'interview material access')
        }
      },
    },
  },
})
