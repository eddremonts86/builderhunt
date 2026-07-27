import { createFileRoute } from '@tanstack/react-router'
import { BookingConflictError, rescheduleBooking } from '~/lib/scheduling/booking-service'
import {
  BOOKING_REQUIRED_PURPOSES,
  CANDIDATE_NOTICE,
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
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
      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        const parsed = bookSlotRequestSchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return withPublicHeaders(publicError('invalid_input'))
        const slotStartsAt = new Date(parsed.data.slotStartsAt)

        try {
          const result = await withCapabilityRequest(request, params.invitationId, ({ transaction, tenant }) =>
            rescheduleBooking(transaction, {
              organizationId: tenant.organizationId,
              ownerUserId: tenant.ownerUserId,
              invitationId: tenant.invitationId,
              slotId: parsed.data.slotId,
              consentReceiptIds: parsed.data.consentReceiptIds,
              requiredPurposes: BOOKING_REQUIRED_PURPOSES,
              noticeVersion: CANDIDATE_NOTICE,
              slotStartsAtHint: slotStartsAt,
            }))

          if (!result.ok) return withPublicHeaders(publicError('invitation_unavailable'))

          const moved = result.value
          if (!moved.ok) {
            return withPublicHeaders(publicError(moved.code, {
              ...(moved.missingPurposes ? { missingPurposes: moved.missingPurposes } : {}),
            }))
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
