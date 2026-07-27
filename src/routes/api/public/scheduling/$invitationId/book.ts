import { createFileRoute } from '@tanstack/react-router'
import { BookingConflictError, bookSlot } from '~/lib/scheduling/booking-service'
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
 * Confirms a slot (plan: calendar-scheduling-interview-intelligence, Phase 5).
 *
 * Two things the request cannot decide for itself:
 *
 * 1. **Which purposes are required.** The list comes from the server. A client that could shorten it
 *    could book with no consent at all, which is the single most important thing this endpoint must
 *    not permit.
 * 2. **Which notice version counts.** Also from the server, for the same reason: a receipt against a
 *    version the candidate never saw is not consent.
 *
 * `slotStartsAt` is echoed back from the slots response purely so the booking service can derive the
 * advisory-lock key before it recomputes. It is a hint, never the authority — the recomputed slot
 * decides when the appointment is, and a request naming a start that no longer has a slot loses.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/book')({
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
            bookSlot(transaction, {
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

          const booking = result.value
          if (!booking.ok) {
            return withPublicHeaders(publicError(booking.code, {
              ...(booking.missingPurposes ? { missingPurposes: booking.missingPurposes } : {}),
              // spec.md: a race loser gets refreshed alternatives, not a dead end.
              ...(booking.alternatives
                ? {
                    alternatives: booking.alternatives.map((slot) => ({
                      slotId: slot.slotId,
                      startsAt: slot.startsAt.toISOString(),
                      endsAt: slot.endsAt.toISOString(),
                    })),
                  }
                : {}),
            }))
          }

          return withPublicHeaders(Response.json({
            eventId: booking.eventId,
            startsAt: booking.startsAt.toISOString(),
            endsAt: booking.endsAt.toISOString(),
            timezone: booking.timezone,
            alreadyBooked: booking.alreadyBooked,
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
          console.error('public scheduling book error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
