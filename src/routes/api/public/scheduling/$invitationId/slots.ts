import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import {
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { querySlots } from '~/lib/scheduling/slot-service'
import { findInvitationByCapabilityHash } from '~/shared/lib/repositories/scheduling'

/**
 * The bookable times for this invitation (plan: calendar-scheduling-interview-intelligence,
 * Phase 5).
 *
 * Returns slot id, start, and end. Nothing else — spec.md: "Return opaque availability only; never
 * reveal the event causing a conflict." A candidate learns that 11:00 is unavailable and never why,
 * which is enforced in `slot-service.ts` and preserved here by not adding fields to the response.
 *
 * The range is read from the query string and clamped by the service. An unauthenticated caller
 * asking for `?from=1970&to=2999` gets a bounded window, not a bounded bill.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/slots')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, false)
        if (refused) return refused

        const url = new URL(request.url)
        const from = parseInstant(url.searchParams.get('from')) ?? new Date()
        const to = parseInstant(url.searchParams.get('to'))
          ?? new Date(from.getTime() + 14 * 24 * 60 * 60_000)

        try {
          const result = await withCapabilityRequest(request, params.invitationId, async ({ transaction, tenant }) => {
            const invitation = await findInvitationByCapabilityHash(transaction, tenant.capabilityHash, new Date())
            if (!invitation) return null

            /**
             * A booked invitation still answers with times.
             *
             * It used to return an empty list on the reasoning that "the candidate's next action is
             * cancel or reschedule, not pick" — but rescheduling *is* picking. `CandidatePortal`'s
             * `startReschedule()` opens the new-time picker and calls this endpoint to fill it, so the
             * empty list made the move unreachable through the UI: an empty picker, no error, and a
             * `POST /reschedule` that no candidate could ever produce. Found by
             * `tests/e2e/scheduling-reschedule.spec.ts`, which could not get a second slot to move to.
             *
             * The candidate's own appointment is naturally absent from the result — it makes the
             * organizer busy — which is the right answer for a picker asking where else you could go.
             * The service releases it before recomputing, so the same time remains reachable through a
             * cancel-and-rebook if that is what the candidate wants.
             */
            const derived = await querySlots(transaction, {
              organizationId: tenant.organizationId,
              ownerUserId: tenant.ownerUserId,
              durationMinutes: invitation.durationMinutes,
              from,
              to,
            })
            return { slots: derived.slots }
          })

          if (!result.ok || !result.value) return withPublicHeaders(publicError('invitation_unavailable'))

          return withPublicHeaders(Response.json({
            slots: result.value.slots.map((slot) => ({
              slotId: slot.slotId,
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
            })),
          }))
        } catch (error) {
          console.error('public scheduling slots error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})

/** A bad date is treated as absent rather than as an error: the defaults are a sensible window. */
function parseInstant(raw: string | null): Date | null {
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
