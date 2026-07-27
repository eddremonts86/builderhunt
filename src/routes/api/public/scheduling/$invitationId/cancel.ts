import { createFileRoute } from '@tanstack/react-router'
import { cancelBooking } from '~/lib/scheduling/booking-service'
import {
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'

/**
 * The candidate cancels a confirmed interview (plan:
 * calendar-scheduling-interview-intelligence, Phase 5).
 *
 * Idempotent: cancelling twice succeeds. Someone cancelling an interview is not in a state where a
 * confusing error is helpful, and the second request has the same end state as the first.
 *
 * The invitation stays `booked` afterwards — see `cancelBooking`. It *was* booked, and the record of
 * that is not the candidate's to erase.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/cancel')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        try {
          const result = await withCapabilityRequest(request, params.invitationId, ({ transaction, tenant }) =>
            cancelBooking(transaction, {
              organizationId: tenant.organizationId,
              ownerUserId: tenant.ownerUserId,
              invitationId: tenant.invitationId,
            }))

          if (!result.ok) return withPublicHeaders(publicError('invitation_unavailable'))
          if (!result.value.ok) return withPublicHeaders(publicError(result.value.code))

          return withPublicHeaders(Response.json({ status: 'cancelled', eventId: result.value.eventId }))
        } catch (error) {
          console.error('public scheduling cancel error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
