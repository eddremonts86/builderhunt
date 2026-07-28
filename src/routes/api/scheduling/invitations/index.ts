import { createFileRoute } from '@tanstack/react-router'
import { createInvitation, invitationAuditDetails, listInvitations } from '~/lib/scheduling/invitation-service'
import { querySlots } from '~/lib/scheduling/slot-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { createInvitationRequestSchema } from '~/shared/lib/interview-api'
import { ensureDefaultCalendar } from '~/shared/lib/repositories/calendar'
import { findAvailabilityPolicy } from '~/shared/lib/repositories/scheduling'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'

/**
 * Owner-only invitation collection (plan: calendar-scheduling-interview-intelligence, Phase 5 "Add
 * authenticated invitation APIs").
 *
 * Two things about the POST response are deliberate and load-bearing:
 *
 * 1. **The capability secret is not in it.** spec.md's API table says this endpoint "returns draft
 *    preview only". The secret exists for exactly one purpose — going into a link fragment in the
 *    invitation email — and a response body travels through logs, browser devtools, error reporters
 *    and analytics on its way to the organizer's screen. It is generated inside the transaction and
 *    dropped; the send step is what puts it in front of a human.
 * 2. **The preview is real availability, not a promise.** It comes from the same `querySlots` a
 *    candidate will call, so an organizer with nothing free sees that before sending rather than
 *    after the candidate reports an empty page.
 */

const PREVIEW_DAYS = 14
const PREVIEW_LIMIT = 50

function invitationErrorResponse(error: unknown) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: 'authentication_required' }, { status: 401 })
  }
  console.error('scheduling invitations route error:', error)
  return Response.json({ error: 'invalid_input' }, { status: 400 })
}

/** Maps the service's vocabulary onto HTTP. `not_found` is 404 for a row that exists but is not yours, by design. */
export function invitationFailureResponse(failure: { error: string; message: string }) {
  const status = failure.error === 'not_found'
    ? 404
    : failure.error === 'forbidden'
      ? 403
      // `already_sent` joins the conflicts: the request is well-formed and the caller is allowed,
      // the invitation is simply not in a state that can accept it.
      : failure.error === 'version_conflict' || failure.error === 'invalid_transition' || failure.error === 'already_sent'
        ? 409
        : 400
  return Response.json({ error: failure.error, message: failure.message }, { status })
}

export function schedulingDisabledResponse() {
  return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
}

/**
 * The organizer-facing shape. Explicit rather than spreading the row: `capability_hash` is already
 * absent from the repository's column list, and listing fields here means a column added to the
 * table later cannot start appearing in an API response without someone deciding it should.
 */
export function toInvitationDto(invitation: {
  id: string
  status: string
  roleTitle: string
  roleContext: string
  durationMinutes: number
  timezone: string
  modality: string
  meetingUrl: string | null
  location: string | null
  candidateEmailNormalized: string | null
  organizationBuilderId: string | null
  expiresAt: Date | null
  openedAt: Date | null
  bookedAt: Date | null
  revokedAt: Date | null
  bookedEventId: string | null
  rescheduleCount: number
  version: number
}) {
  return {
    invitationId: invitation.id,
    status: invitation.status,
    roleTitle: invitation.roleTitle,
    roleContext: invitation.roleContext,
    durationMinutes: invitation.durationMinutes,
    timezone: invitation.timezone,
    modality: invitation.modality,
    meetingUrl: invitation.meetingUrl,
    location: invitation.location,
    candidateEmail: invitation.candidateEmailNormalized,
    organizationBuilderId: invitation.organizationBuilderId,
    expiresAt: invitation.expiresAt?.toISOString() ?? null,
    openedAt: invitation.openedAt?.toISOString() ?? null,
    bookedAt: invitation.bookedAt?.toISOString() ?? null,
    revokedAt: invitation.revokedAt?.toISOString() ?? null,
    bookedEventId: invitation.bookedEventId,
    rescheduleCount: invitation.rescheduleCount,
    version: invitation.version,
  }
}

export const Route = createFileRoute('/api/scheduling/invitations/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          if (env.SCHEDULING_ENABLED === 'false') return schedulingDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const invitations = await withTenantContext(principal, (tx) => listInvitations(tx, principal))
          return Response.json({ invitations: invitations.map(toInvitationDto) })
        } catch (error) {
          return invitationErrorResponse(error)
        }
      },
      POST: async ({ request }) => {
        try {
          if (env.SCHEDULING_ENABLED === 'false') return schedulingDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const parsed = createInvitationRequestSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const outcome = await withTenantContext(principal, async (tx) => {
            /*
             * The organizer's calendar has to exist before anyone can book into it.
             *
             * `bookSlot` runs under the capability role and cannot create one — correctly: a
             * candidate must not be able to write a `user_calendars` row. So the calendar has to be
             * in place by the time the link goes out, and issuing an invitation is the act that says
             * time can be booked with me. Without this, an organizer who never hand-created a
             * calendar event sent a working link whose booking failed with `invalid_input`, which
             * reads to the candidate as though their own submission was wrong.
             */
            await ensureDefaultCalendar(tx, {
              organizationId: principal.organizationId,
              ownerUserId: principal.userId,
              timezone: parsed.data.timezone,
            })
            // The policy version is snapshotted onto the invitation so a booking can tell that the
            // organizer changed their availability after the candidate saw it.
            const policy = await findAvailabilityPolicy(tx, principal.organizationId, principal.userId)
            const created = await createInvitation(tx, principal, {
              candidateEmail: parsed.data.candidateEmail,
              roleTitle: parsed.data.roleTitle,
              roleContext: parsed.data.roleContext,
              durationMinutes: parsed.data.durationMinutes,
              timezone: parsed.data.timezone,
              modality: parsed.data.modality,
              meetingUrl: parsed.data.meetingUrl ?? null,
              location: parsed.data.location ?? null,
              organizationBuilderId: parsed.data.organizationBuilderId ?? null,
            }, String(policy?.version ?? 1))
            if (!created.ok) return created

            const now = new Date()
            const preview = await querySlots(tx, {
              organizationId: principal.organizationId,
              ownerUserId: principal.userId,
              durationMinutes: parsed.data.durationMinutes,
              from: now,
              to: new Date(now.getTime() + PREVIEW_DAYS * 24 * 60 * 60_000),
              now,
            })
            return { ok: true as const, invitation: created.value.invitation, preview: preview.slots }
          })

          if (!outcome.ok) return invitationFailureResponse(outcome)

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'scheduling.invitation.created',
            targetType: 'scheduling_invitation',
            targetId: outcome.invitation.id,
            result: 'allowed',
            requestId: principal.requestId,
            // Status, version, and modality only. The candidate's email and the role context are the
            // candidate's data, not audit evidence about the organizer's action.
            details: invitationAuditDetails(outcome.invitation),
          }, consoleSecurityAuditSink)

          return Response.json({
            invitationId: outcome.invitation.id,
            roleTitle: outcome.invitation.roleTitle,
            durationMinutes: outcome.invitation.durationMinutes,
            modality: outcome.invitation.modality,
            status: outcome.invitation.status,
            version: outcome.invitation.version,
            availabilityPreview: outcome.preview.slice(0, PREVIEW_LIMIT).map((slot) => ({
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
            })),
          }, { status: 201 })
        } catch (error) {
          return invitationErrorResponse(error)
        }
      },
    },
  },
})
