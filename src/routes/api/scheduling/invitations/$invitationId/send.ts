import { createFileRoute } from '@tanstack/react-router'
import { invitationAuditDetails, markInvitationSent } from '~/lib/scheduling/invitation-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { invitationStateChangeRequestSchema } from '~/shared/lib/interview-api'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { invitationFailureResponse, schedulingDisabledResponse } from '../index'

/**
 * Marks an invitation sent (plan: calendar-scheduling-interview-intelligence, Phase 5).
 *
 * The request carries the version the organizer's UI was showing, so a send racing another tab's
 * revoke loses with `409` instead of resurrecting a revoked invitation. A send from `sent` is a
 * resend and succeeds, reusing the same capability — reissuing one would silently break the link
 * already in the candidate's inbox.
 *
 * Delivery is not here. The email/`.ics` task wires the outbox write into this same transaction so a
 * committed `sent` status and a queued email cannot disagree.
 */
export const Route = createFileRoute('/api/scheduling/invitations/$invitationId/send')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          if (env.SCHEDULING_ENABLED === 'false') return schedulingDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const parsed = invitationStateChangeRequestSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const result = await withTenantContext(principal, (tx) =>
            markInvitationSent(tx, principal, params.invitationId, parsed.data.version))
          if (!result.ok) return invitationFailureResponse(result)

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'scheduling.invitation.sent',
            targetType: 'scheduling_invitation',
            targetId: result.value.id,
            result: 'allowed',
            requestId: principal.requestId,
            details: invitationAuditDetails(result.value),
          }, consoleSecurityAuditSink)

          return Response.json({
            invitationId: result.value.id,
            status: result.value.status,
            version: result.value.version,
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: 'authentication_required' }, { status: 401 })
          }
          console.error('scheduling invitation send route error:', error)
          return Response.json({ error: 'invalid_input' }, { status: 400 })
        }
      },
    },
  },
})
