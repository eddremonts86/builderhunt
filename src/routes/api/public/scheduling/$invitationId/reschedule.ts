import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { BookingConflictError, rescheduleBooking } from '~/lib/scheduling/booking-service'
import {
  BOOKING_REQUIRED_PURPOSES,
  CANDIDATE_NOTICE,
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { notifyAppointmentChange } from '~/lib/scheduling/notifications'
import { bookSlotRequestSchema } from '~/shared/lib/interview-api'

/**
 * The candidate moves a confirmed interview (plan:
 * calendar-scheduling-interview-intelligence, Phase 5).
 *
 * Same request shape as booking, because it is the same decision made again: a slot plus the consent
 * receipts. Consent is re-verified rather than inherited — a purpose withdrawn since the original
 * booking blocks the move, exactly as it would block a first booking.
 *
 * A reschedule that cannot land throws inside the service so the whole transaction rolls back,
 * leaving the original appointment untouched. That is why `BookingConflictError` is caught here and
 * turned into `409` with alternatives, rather than being allowed to become a 500 for a candidate who
 * still has a perfectly good appointment.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/reschedule')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        const parsed = bookSlotRequestSchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return withPublicHeaders(publicError('invalid_input'))
        const slotStartsAt = new Date(parsed.data.slotStartsAt)

        try {
          // The organization id is only known inside the capability context, and the notification below
          // runs after it closes — so it travels out with the result rather than being re-derived.
          let organizationId: string | null = null
          const result = await withCapabilityRequest(request, params.invitationId, ({ transaction, tenant }) => {
            organizationId = tenant.organizationId
            return rescheduleBooking(transaction, {
              organizationId: tenant.organizationId,
              ownerUserId: tenant.ownerUserId,
              invitationId: tenant.invitationId,
              slotId: parsed.data.slotId,
              consentReceiptIds: parsed.data.consentReceiptIds,
              requiredPurposes: BOOKING_REQUIRED_PURPOSES,
              noticeVersion: CANDIDATE_NOTICE,
              slotStartsAtHint: slotStartsAt,
            })
          })

          if (!result.ok) return withPublicHeaders(publicError('invitation_unavailable'))

          const moved = result.value
          if (!moved.ok) {
            return withPublicHeaders(publicError(moved.code, {
              ...(moved.missingPurposes ? { missingPurposes: moved.missingPurposes } : {}),
            }))
          }

          /*
           * Both parties get the updated appointment with a fresh ICS. `calendar_events.version` has
           * moved, which is what makes this a genuinely new notice rather than a suppressed duplicate
           * (`notifications.ts`, decision 4) and what makes a calendar client update the entry in place
           * instead of adding a second one.
           */
          if (organizationId) {
            await notifyAppointmentChange({ organizationId, invitationId: params.invitationId, kind: 'reschedule' })
          }

          return withPublicHeaders(Response.json({
            eventId: moved.eventId,
            startsAt: moved.startsAt.toISOString(),
            endsAt: moved.endsAt.toISOString(),
            timezone: moved.timezone,
          }))
        } catch (error) {
          if (error instanceof BookingConflictError) {
            return withPublicHeaders(publicError('slot_unavailable', {
              alternatives: error.alternatives.map((slot) => ({
                slotId: slot.slotId,
                startsAt: slot.startsAt.toISOString(),
                endsAt: slot.endsAt.toISOString(),
              })),
            }))
          }
          console.error('public scheduling reschedule error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
