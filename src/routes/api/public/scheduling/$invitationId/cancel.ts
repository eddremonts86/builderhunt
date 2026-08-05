import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { cancelBooking } from '~/lib/scheduling/booking-service'
import {
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { notifyAppointmentChange } from '~/lib/scheduling/notifications'

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
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        try {
          // The organization id is only known inside the capability context, and the notification below
          // runs after it closes — so it travels out with the result rather than being re-derived.
          let organizationId: string | null = null
          const result = await withCapabilityRequest(request, params.invitationId, ({ transaction, tenant }) => {
            organizationId = tenant.organizationId
            return cancelBooking(transaction, {
              organizationId: tenant.organizationId,
              ownerUserId: tenant.ownerUserId,
              invitationId: tenant.invitationId,
            })
          })

          if (!result.ok) return withPublicHeaders(publicError('invitation_unavailable'))
          if (!result.value.ok) return withPublicHeaders(publicError(result.value.code))

          /*
           * A CANCEL carrying the same UID and a higher SEQUENCE is what removes the entry from both
           * calendars. Without it the interview stays in two calendars indefinitely and only the portal
           * knows it is off — which is the failure mode a candidate experiences as being ghosted.
           *
           * Sent before the response for the same reason as the other two: awaited so a runtime cannot
           * kill the process mid-send, and non-fatal because the cancellation has already committed.
           */
          if (organizationId) {
            await notifyAppointmentChange({ organizationId, invitationId: params.invitationId, kind: 'cancellation' })
          }

          return withPublicHeaders(Response.json({ status: 'cancelled', eventId: result.value.eventId }))
        } catch (error) {
          console.error('public scheduling cancel error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
