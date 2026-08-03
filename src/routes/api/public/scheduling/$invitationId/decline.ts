import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { capabilitySessionClearCookie } from '~/lib/scheduling/capability-session'
import {
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { findInvitationByCapabilityHash, updateInvitationStateWithVersion } from '~/shared/lib/repositories/scheduling'
import { assertValidInvitationStatusTransition } from '~/shared/lib/scheduling'

/**
 * The candidate declines (plan: calendar-scheduling-interview-intelligence, Phase 5).
 *
 * Declining is terminal and clears the session cookie, because there is nothing left for this
 * browser to do with the capability. The invitation status graph makes it unreachable from `booked`,
 * so a candidate who wants out of a confirmed interview cancels instead — declining would leave a
 * confirmed event on the organizer's calendar with a declined invitation beside it.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/decline')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        try {
          const result = await withCapabilityRequest(request, params.invitationId, async ({ transaction, tenant }) => {
            const invitation = await findInvitationByCapabilityHash(transaction, tenant.capabilityHash, new Date())
            if (!invitation) return null
            try {
              assertValidInvitationStatusTransition(invitation.status as 'opened', 'declined')
            } catch {
              return { declined: false as const }
            }
            const row = await updateInvitationStateWithVersion(
              transaction,
              tenant.organizationId,
              tenant.ownerUserId,
              tenant.invitationId,
              invitation.version,
              { status: 'declined' },
            )
            return { declined: row !== null }
          })

          if (!result.ok || !result.value) return withPublicHeaders(publicError('invitation_unavailable'))
          if (!result.value.declined) return withPublicHeaders(publicError('invitation_unavailable'))

          return withPublicHeaders(
            Response.json({ status: 'declined' }),
            capabilitySessionClearCookie(params.invitationId),
          )
        } catch (error) {
          console.error('public scheduling decline error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
