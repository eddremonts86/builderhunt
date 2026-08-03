import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { withCapabilityContext } from '~/lib/scheduling/capability-context'
import { capabilitySessionSetCookie } from '~/lib/scheduling/capability-session'
import {
  BOOKING_REQUIRED_PURPOSES,
  CANDIDATE_NOTICE,
  guardPublicRequest,
  publicError,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { exchangeCapabilitySessionRequestSchema } from '~/shared/lib/interview-api'
import { findInvitationByCapabilityHash, updateInvitationStateWithVersion } from '~/shared/lib/repositories/scheduling'
import { assertValidInvitationStatusTransition } from '~/shared/lib/scheduling'

/**
 * Exchanges the fragment secret for an invitation-scoped cookie (plan:
 * calendar-scheduling-interview-intelligence, Phase 5).
 *
 * This is the one endpoint that accepts a secret in a request body, and the reason it exists is to
 * be the *last* place the secret is handled by JavaScript. The candidate's page reads it from
 * `location.hash`, POSTs it here, replaces its own history entry, and forgets it; every later
 * request proves itself with the `HttpOnly` cookie this response sets.
 *
 * The exchange also marks the invitation `opened`, which is both the organizer's read receipt and
 * the state the booking transition requires. It is best-effort: a candidate who opens the link twice,
 * or who opens one already booked, still gets a working session. Failing the exchange because a
 * status write did not apply would strand them on a dead page over bookkeeping.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/session')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        const parsed = exchangeCapabilitySessionRequestSchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return withPublicHeaders(publicError('invalid_input'))

        try {
          const resolved = await withCapabilityContext(parsed.data.secret, async (transaction, tenant) => {
            const invitation = await findInvitationByCapabilityHash(transaction, tenant.capabilityHash, new Date())
            if (!invitation) return null

            // `opened` is only reachable from `sent`; anything else (already opened, already booked)
            // is left alone rather than forced.
            try {
              assertValidInvitationStatusTransition(invitation.status as 'sent', 'opened')
              await updateInvitationStateWithVersion(
                transaction,
                tenant.organizationId,
                tenant.ownerUserId,
                tenant.invitationId,
                invitation.version,
                { status: 'opened', openedAt: new Date() },
              )
            } catch {
              // Not a legal transition from here. Nothing to record; the session is still valid.
            }

            return invitation
          }, { invitationId: params.invitationId })

          if (!resolved.ok || !resolved.value) {
            return withPublicHeaders(publicError('invitation_unavailable'))
          }

          const invitation = resolved.value
          return withPublicHeaders(Response.json({
            roleTitle: invitation.roleTitle,
            roleContext: invitation.roleContext,
            durationMinutes: invitation.durationMinutes,
            timezone: invitation.timezone,
            modality: invitation.modality,
            meetingUrl: invitation.meetingUrl,
            location: invitation.location,
            policyVersion: invitation.policyVersion,
            noticeVersion: CANDIDATE_NOTICE,
            requiredPurposes: BOOKING_REQUIRED_PURPOSES,
          }), capabilitySessionSetCookie(params.invitationId, parsed.data.secret))
        } catch (error) {
          console.error('public scheduling session error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
