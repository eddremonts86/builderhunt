/**
 * Interview appointment notifications (plan: calendar-scheduling-interview-intelligence, Phase 5
 * "Add calendar invitation email and ICS generation").
 *
 * The invitation email itself was already wired (`POST .../send` → `sendInterviewInvitationEmail`).
 * This is the other half the plan recorded as open: the confirmation, reschedule and cancellation
 * notices, with their ICS payloads, for the transitions the *candidate* drives from the portal. Before
 * this existed, a candidate could book an interview and neither party received anything — no
 * confirmation, and no entry in either calendar.
 *
 * ## Four decisions worth knowing before changing this
 *
 * **1. No portal link, ever.** These emails carry the appointment and its ICS, and no capability. The
 * secret is minted at send and only its hash is persisted (see `invitation-service.ts`), so nothing
 * here could reproduce the candidate's link, and minting a fresh one would silently orphan the link
 * already in their inbox. That is the "no resend" semantics the maintainer chose, applied consistently:
 * the candidate already has their link, and a confirmation is not a place to hand out a new one.
 *
 * **2. Worker role, in its own transaction, after the request's.** The candidate-facing routes authorize
 * as `builderhunt_capability`, which holds SELECT and nothing else — writing the delivery ledger from
 * there is a 42501, not a bug to work around. So notification runs afterwards through
 * `withWorkerOrganization` and re-reads by invitation id.
 *
 * **3. Best-effort, and it says so.** A committed booking must never be rolled back because Resend was
 * down. Every failure is recorded in the delivery ledger and logged as a code; nothing propagates to the
 * caller. The candidate's booking is real whether or not the email arrived — the opposite arrangement
 * would let a mail outage refuse interviews.
 *
 * **4. Idempotency is keyed on the appointment, not just the invitation.** The key is
 * `scheduling:<invitationId>:<kind>:<eventId>:<eventVersion>:<recipient>`, so a retried POST cannot
 * double-send while a genuinely new appointment does.
 *
 * Both halves of that key earn their place, and the first version had only one of them. **A reschedule
 * does not edit the event in place — it creates a replacement** and repoints
 * `scheduling_invitations.booked_event_id` at it (see `tests/e2e/scheduling-reschedule.spec.ts`, "the
 * move creates a replacement event"). The new event's `version` starts at 1, so a key built from the
 * version alone is *identical* for the first and second reschedule of one invitation, and the second
 * candidate would never be told their interview moved. The event id distinguishes replacements; the
 * version still distinguishes an in-place edit of one event. Found 2026-08-05 while writing the e2e.
 */

import { log } from '~/shared/lib/log'
import { sendCalendarEventEmail } from '~/shared/lib/email'
import { insertDeliveryIfAbsent } from '~/shared/lib/repositories/calendar'
import {
  findDeliveryByIdempotencyKey,
  findSchedulingNotificationContext,
  findUserEmail,
  markDeliveryOutcome,
  withWorkerOrganization,
} from '~/shared/lib/repositories/calendar-worker'
import { buildEventIcs } from '~/lib/calendar/ics'

/** The three transitions that change an appointment a calendar client is holding. */
export type AppointmentNotificationKind = 'invitation' | 'reschedule' | 'cancellation'

export interface AppointmentNotificationResult {
  kind: AppointmentNotificationKind
  /** One entry per recipient the notice was attempted for. */
  outcomes: Array<{ role: 'candidate' | 'organizer'; state: 'sent' | 'failed' | 'skipped_duplicate' | 'no_address' }>
}

/**
 * Notifies both parties that an appointment was created, moved or cancelled.
 *
 * Never throws. Returns what happened so a caller can log it; no caller should branch on it, because
 * the transition it describes has already committed.
 */
export async function notifyAppointmentChange(input: {
  organizationId: string
  invitationId: string
  kind: AppointmentNotificationKind
}): Promise<AppointmentNotificationResult> {
  const result: AppointmentNotificationResult = { kind: input.kind, outcomes: [] }

  try {
    await withWorkerOrganization(input.organizationId, async (transaction) => {
      const context = await findSchedulingNotificationContext(transaction, input.organizationId, input.invitationId)
      if (!context) {
        // No booked event. A decline or an expiry lands here and it is the normal case, not a fault.
        log.info('scheduling_notification_skipped', { invitationId: input.invitationId, kind: input.kind, reason: 'no_booked_event' })
        return
      }

      const organizerEmail = await findUserEmail(transaction, context.ownerUserId)
      const icsContent = buildEventIcs({
        eventId: context.eventId,
        version: context.eventVersion,
        title: context.eventTitle,
        startsAt: context.startsAt,
        endsAt: context.endsAt,
        timezone: context.timezone,
        location: context.location,
        meetingUrl: context.meetingUrl,
        organizerEmail,
        // The candidate is an ATTENDEE on the ICS, which is what makes a client offer
        // accept/decline rather than render a read-only blob.
        attendees: context.candidateEmail ? [{ email: context.candidateEmail }] : [],
      }, input.kind === 'cancellation' ? 'CANCEL' : 'REQUEST')

      const recipients: Array<{ role: 'candidate' | 'organizer'; email: string | null; userId: string | null }> = [
        { role: 'candidate', email: context.candidateEmail, userId: null },
        { role: 'organizer', email: organizerEmail, userId: context.ownerUserId },
      ]

      for (const recipient of recipients) {
        if (!recipient.email) {
          // An invitation for a tracked builder resolves its address elsewhere and may have none on
          // the row; that is a real configuration, not an error.
          result.outcomes.push({ role: recipient.role, state: 'no_address' })
          continue
        }

        // The key still carries the `scheduling:` namespace — it is a free-text column with no CHECK,
        // and it keeps these apart from the reminder worker's keys for the same event.
        const idempotencyKey = `scheduling:${input.invitationId}:${input.kind}:${context.eventId}:${context.eventVersion}:${recipient.role}`
        const claimed = await insertDeliveryIfAbsent(transaction, {
          organizationId: input.organizationId,
          eventId: context.eventId,
          /*
           * The bare kind, not a `scheduling_`-prefixed one.
           * `calendar_notification_deliveries_kind_check` allows exactly
           * `reminder | invitation | reschedule | cancellation`, and those three are precisely the
           * transitions this module handles — the prefix was invented and every insert violated the
           * constraint with 23514. The module's own catch swallowed it and logged
           * `scheduling_notification_failed`, so bookings kept working and nobody was ever notified.
           * Found 2026-08-05 while writing the e2e; the unit tests mock this repository and could not
           * see a CHECK.
           */
          kind: input.kind,
          invitationId: input.invitationId,
          recipientUserId: recipient.userId,
          // Same convention as the reminder worker: an external recipient is recorded by address,
          // because a hash we would have to reverse later is not an identifier.
          externalRecipientHash: recipient.userId ? null : recipient.email,
          idempotencyKey,
        })

        let deliveryId = claimed?.id ?? null
        if (deliveryId === null) {
          // Someone already claimed this key. Only a FAILED row is ours to retry — a sent or in-flight
          // one means this notice is already on its way.
          const existing = await findDeliveryByIdempotencyKey(transaction, input.organizationId, idempotencyKey)
          if (!existing || existing.state !== 'failed') {
            result.outcomes.push({ role: recipient.role, state: 'skipped_duplicate' })
            continue
          }
          deliveryId = existing.id
        }

        const sent = await sendCalendarEventEmail(recipient.email, {
          kind: input.kind,
          title: context.eventTitle,
          startsAt: context.startsAt,
          endsAt: context.endsAt,
          timezone: context.timezone,
          location: context.location,
          meetingUrl: context.meetingUrl,
          icsContent,
        })

        if (sent.ok) {
          await markDeliveryOutcome(transaction, input.organizationId, deliveryId, {
            state: 'sent',
            providerReference: sent.id ?? null,
          })
          result.outcomes.push({ role: recipient.role, state: 'sent' })
          continue
        }

        // A short code only. These rows surface in the UI, and a provider message can carry an address.
        await markDeliveryOutcome(transaction, input.organizationId, deliveryId, { state: 'failed', errorCode: 'send_failed' })
        result.outcomes.push({ role: recipient.role, state: 'failed' })
      }

      log.info('scheduling_notification_run', {
        invitationId: input.invitationId,
        kind: input.kind,
        eventVersion: context.eventVersion,
        outcomes: result.outcomes.map((outcome) => `${outcome.role}:${outcome.state}`),
      })
    })
  } catch (error) {
    // Swallowed on purpose — see decision 3 in the module header. The booking already committed.
    log.error('scheduling_notification_failed', { invitationId: input.invitationId, kind: input.kind, error })
  }

  return result
}
