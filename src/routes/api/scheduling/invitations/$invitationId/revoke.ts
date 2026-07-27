import { createFileRoute } from '@tanstack/react-router'
import { invitationAuditDetails, revokeInvitation } from '~/lib/scheduling/invitation-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { invitationStateChangeRequestSchema } from '~/shared/lib/interview-api'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { invitationFailureResponse, schedulingDisabledResponse } from '../index'

/**
 * Revokes an invitation (plan: calendar-scheduling-interview-intelligence, Phase 5).
 *
 * Revocation is terminal and immediate: the capability stops resolving because
 * `findInvitationByCapabilityHash` filters on status, so the candidate's link dies with this request
 * rather than waiting for an expiry sweep. Revoking an already-revoked invitation is a `409` from the
 * shared state machine, not a silent success — an organizer clicking revoke twice should learn that
 * the second click did nothing.
 */
export const Route = createFileRoute('/api/scheduling/invitations/$invitationId/revoke')({
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
            revokeInvitation(tx, principal, params.invitationId, parsed.data.version))
          if (!result.ok) return invitationFailureResponse(result)

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'scheduling.invitation.revoked',
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
          console.error('scheduling invitation revoke route error:', error)
          return Response.json({ error: 'invalid_input' }, { status: 400 })
        }
      },
    },
  },
})
