/**
 * Atomic booking, cancellation, and rescheduling (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Implement atomic booking, cancellation, and
 * rescheduling"; spec.md §"Scheduling correctness").
 *
 * The one hard requirement here is "zero confirmed double bookings" (spec.md §Success metrics), and
 * the mechanism is a transaction advisory lock, not a unique constraint. A unique index cannot
 * express it: two bookings conflict when their intervals *overlap*, not when their start instants
 * are equal, and a candidate booking 10:00–10:45 must lose to an existing 10:30–11:15. So:
 *
 *   1. `pg_advisory_xact_lock(organizer, local date)` — every booking for one organizer on one day
 *      serializes. The lock is released by commit or rollback, never by us, so a failure between the
 *      lock and the commit cannot wedge the day.
 *   2. Recompute the slot *inside* the lock. The slot id the candidate submitted was derived from a
 *      calendar that may have changed while they filled in the form; it is a claim, not a fact. The
 *      recomputation is the authority, which is also what makes the whole check-then-write sequence
 *      safe under concurrency.
 *   3. Write everything in the caller's transaction. Event, participants, reminders, and the
 *      invitation's booked state commit together or not at all.
 *
 * The lock key is organizer + local date rather than the whole organizer: two candidates booking
 * different days have no way to conflict, and serializing them would turn a busy organizer's
 * calendar into a queue.
 *
 * What this module does NOT do is send anything. Email and `.ics` are a separate Phase 5 task; the
 * result carries the facts a notification needs so the caller can enqueue it after commit. Sending
 * from inside the transaction would either send for a booking that later rolled back, or hold the
 * lock open across a network call to Resend.
 */
import { sql } from 'drizzle-orm'
import type { TenantTransaction } from '~/shared/lib/db/client'
import {
  cancelRemindersForEvent,
  findDefaultCalendar,
  findEventById,
  insertEvent,
  insertParticipants,
  insertReminders,
  updateEventWithVersion,
} from '~/shared/lib/repositories/calendar'
import {
  findAvailabilityPolicy,
  findInvitationForOwner,
  findSubmissionByInvitation,
  updateInvitationStateWithVersion,
} from '~/shared/lib/repositories/scheduling'
import type { ConsentPurpose, InvitationStatus } from '~/shared/lib/scheduling'
import { assertValidInvitationStatusTransition, INVITATION_STATUSES } from '~/shared/lib/scheduling'
import { verifyRequiredConsents } from './consent-service'
import { querySlots } from './slot-service'

/**
 * How far around the requested slot the recomputation looks. One day either side of the slot's own
 * day, so a slot that straddles midnight in the organizer's timezone is still inside the window.
 */
const RECOMPUTE_PADDING_MS = 24 * 60 * 60_000

export type BookingFailureCode =
  | 'invalid_input'
  | 'invitation_unavailable'
  | 'slot_unavailable'
  | 'consent_required'

export interface BookingFailure {
  ok: false
  code: BookingFailureCode
  /** Internal detail for logs and tests. Routes map `code` to a public response; this never ships to a candidate verbatim. */
  reason: string
  /** Populated on `consent_required` so the portal can re-prompt for exactly what is missing. */
  missingPurposes?: ConsentPurpose[]
  /**
   * Populated on `slot_unavailable`. spec.md: "A race loser receives `409 slot_unavailable` and
   * refreshed alternatives" — losing a race must not dead-end the candidate on a page with no way
   * forward, so the alternatives are computed here while the lock is still held and the answer is
   * still true.
   */
  alternatives?: { slotId: string; startsAt: Date; endsAt: Date }[]
}

export interface BookingSuccess {
  ok: true
  eventId: string
  startsAt: Date
  endsAt: Date
  timezone: string
  /**
   * True when this request found the invitation already booked for exactly this slot — a retry, not
   * a new booking. The caller must not enqueue a second confirmation email for it.
   */
  alreadyBooked: boolean
  candidate: { displayName: string; email: string }
}

export type BookingResult = BookingSuccess | BookingFailure

function isInvitationStatus(value: string): value is InvitationStatus {
  return (INVITATION_STATUSES as readonly string[]).includes(value)
}

function fail(code: BookingFailureCode, reason: string, extra: Partial<BookingFailure> = {}): BookingFailure {
  return { ok: false, code, reason, ...extra }
}

/**
 * Serializes every booking for one organizer on one local day.
 *
 * Two 32-bit keys rather than one hashed string: `pg_advisory_xact_lock(int, int)` occupies a
 * different key space from the single-argument form, so a collision with an unrelated advisory lock
 * elsewhere in the codebase would need both halves to match.
 */
async function lockOrganizerDay(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  localDate: string,
): Promise<void> {
  await transaction.execute(sql`
    select pg_advisory_xact_lock(
      hashtext(${`${organizationId}:${ownerUserId}`}),
      hashtext(${localDate})
    )
  `)
}

/** The organizer-local calendar day a slot falls on — the lock's second key. */
function localDayKey(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

export interface BookSlotInput {
  organizationId: string
  ownerUserId: string
  invitationId: string
  /** The opaque slot id the candidate picked, from a previous `querySlots` response. */
  slotId: string
  /** Every consent receipt the candidate is asserting. Verified, not trusted. */
  consentReceiptIds: readonly string[]
  requiredPurposes: readonly ConsentPurpose[]
  /** The notice version the portal rendered. A receipt against a different version does not count. */
  noticeVersion: string
  /**
   * The slot's start, as the candidate's client understood it. Used only to derive the lock's day
   * key and to bound the recomputation window — never to decide when the appointment is. The
   * recomputed slot is the authority.
   */
  slotStartsAtHint: Date
  now?: Date
}

/**
 * Books a slot, or explains why it could not.
 *
 * Ordering is deliberate. The advisory lock comes before the consent check even though consent is
 * cheaper to evaluate: the caller's transaction has to hold the day serialized across the *whole*
 * decision, and a consent check that ran outside the lock would be re-checkable but the slot
 * recomputation would not.
 */
export async function bookSlot(
  transaction: TenantTransaction,
  input: BookSlotInput,
): Promise<BookingResult> {
  const now = input.now ?? new Date()

  const invitation = await findInvitationForOwner(
    transaction,
    input.organizationId,
    input.ownerUserId,
    input.invitationId,
  )
  if (!invitation) return fail('invitation_unavailable', 'invitation not found')

  await lockOrganizerDay(
    transaction,
    input.organizationId,
    input.ownerUserId,
    localDayKey(input.slotStartsAtHint, invitation.timezone),
  )

  // Re-read after the lock: the row we checked above was read before serialization, so a concurrent
  // booking may have moved it in between. This is the read that decides.
  const locked = await findInvitationForOwner(
    transaction,
    input.organizationId,
    input.ownerUserId,
    input.invitationId,
  )
  if (!locked) return fail('invitation_unavailable', 'invitation disappeared under the lock')

  if (locked.status === 'booked') {
    return resolveAlreadyBooked(transaction, input, locked)
  }
  // The shared Phase 1 state machine owns which statuses can reach `booked`; duplicating the answer
  // here is how the two drift apart.
  if (!isInvitationStatus(locked.status)) {
    return fail('invitation_unavailable', `unknown invitation status ${locked.status}`)
  }
  try {
    assertValidInvitationStatusTransition(locked.status, 'booked')
  } catch {
    return fail('invitation_unavailable', `cannot book an invitation in status ${locked.status}`)
  }
  if (locked.expiresAt && locked.expiresAt <= now) {
    return fail('invitation_unavailable', 'invitation expired')
  }

  const submission = await findSubmissionByInvitation(transaction, input.organizationId, input.invitationId)
  if (!submission) {
    return fail('invalid_input', 'candidate details must be submitted before booking')
  }

  const consent = await verifyRequiredConsents(transaction, {
    organizationId: input.organizationId,
    invitationId: input.invitationId,
    consentReceiptIds: input.consentReceiptIds,
    requiredPurposes: input.requiredPurposes,
    noticeVersion: input.noticeVersion,
  })
  if (!consent.ok) {
    return fail('consent_required', consent.reason, { missingPurposes: consent.missingPurposes })
  }

  const recomputed = await recomputeSlots(transaction, input, locked, now)
  const slot = recomputed.find((candidate) => candidate.slotId === input.slotId)
  if (!slot) {
    return fail('slot_unavailable', 'the chosen time is no longer available', {
      alternatives: recomputed.slice(0, 10),
    })
  }

  const calendar = await findDefaultCalendar(transaction, input.organizationId, input.ownerUserId)
  if (!calendar) return fail('invalid_input', 'organizer has no default calendar')

  const event = await insertEvent(transaction, {
    organizationId: input.organizationId,
    calendarId: calendar.id,
    ownerUserId: input.ownerUserId,
    type: 'interview',
    status: 'confirmed',
    title: `Interview: ${locked.roleTitle}`,
    location: locked.location,
    meetingUrl: locked.meetingUrl,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    timezone: locked.timezone,
    allDay: false,
    // A confirmed interview is a hard conflict for anything booked later, so it must occupy the
    // organizer's time rather than sit alongside it as free.
    busy: true,
    sourceType: 'scheduling_invitation',
    sourceId: input.invitationId,
  })

  const participants = await insertParticipants(transaction, [
    {
      organizationId: input.organizationId,
      eventId: event.id,
      eventOwnerUserId: input.ownerUserId,
      userId: input.ownerUserId,
      role: 'organizer',
      accessGranted: true,
    },
    {
      organizationId: input.organizationId,
      eventId: event.id,
      eventOwnerUserId: input.ownerUserId,
      externalEmail: submission.emailNormalized,
      displayName: submission.displayName,
      role: 'attendee',
      // The candidate has no account, so there is nothing to grant access to. Their reach is the
      // capability, not a participant row.
      accessGranted: false,
    },
  ])

  await armReminders(transaction, input, event.id, slot.startsAt, participants)

  const marked = await updateInvitationStateWithVersion(
    transaction,
    input.organizationId,
    input.ownerUserId,
    input.invitationId,
    locked.version,
    { status: 'booked', bookedAt: now, bookedEventId: event.id },
  )
  if (!marked) {
    // Under the advisory lock this should be unreachable, so treat it as a lost race rather than
    // assuming it cannot happen: throwing rolls back the event and participants written above.
    throw new Error('invitation version changed while booking under an advisory lock')
  }

  return {
    ok: true,
    eventId: event.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    timezone: locked.timezone,
    alreadyBooked: false,
    candidate: { displayName: submission.displayName, email: submission.emailNormalized },
  }
}

type InvitationRecord = NonNullable<Awaited<ReturnType<typeof findInvitationForOwner>>>

/**
 * Handles a request against an already-booked invitation.
 *
 * A retry of the winning request and a losing racer's request arrive looking identical, so the
 * existing event decides: if it is the same slot the caller asked for, this is the same booking and
 * returning it is correct. If it is a different time, someone else got there first.
 */
async function resolveAlreadyBooked(
  transaction: TenantTransaction,
  input: BookSlotInput,
  invitation: InvitationRecord,
): Promise<BookingResult> {
  if (!invitation.bookedEventId) {
    return fail('invitation_unavailable', 'invitation is booked but carries no event')
  }
  const existing = await findEventById(transaction, input.organizationId, invitation.bookedEventId)
  if (!existing) {
    return fail('invitation_unavailable', 'invitation is booked but its event is gone')
  }

  const startsAt = existing.startsAt as Date
  const endsAt = existing.endsAt as Date
  if (startsAt.getTime() !== input.slotStartsAtHint.getTime()) {
    return fail('slot_unavailable', 'this invitation is already booked for a different time')
  }

  const submission = await findSubmissionByInvitation(transaction, input.organizationId, input.invitationId)
  return {
    ok: true,
    eventId: invitation.bookedEventId,
    startsAt,
    endsAt,
    timezone: invitation.timezone,
    alreadyBooked: true,
    candidate: {
      displayName: submission?.displayName ?? '',
      email: submission?.emailNormalized ?? '',
    },
  }
}

async function recomputeSlots(
  transaction: TenantTransaction,
  input: BookSlotInput,
  invitation: InvitationRecord,
  now: Date,
) {
  const result = await querySlots(transaction, {
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    durationMinutes: invitation.durationMinutes,
    from: new Date(input.slotStartsAtHint.getTime() - RECOMPUTE_PADDING_MS),
    to: new Date(input.slotStartsAtHint.getTime() + RECOMPUTE_PADDING_MS),
    now,
  })
  return result.slots
}

/**
 * Arms the organizer's default reminder offsets for the new event.
 *
 * Only the organizer's rows are created. A candidate reminder would be an email to someone who
 * never asked for one, and the confirmation email already carries the appointment.
 */
async function armReminders(
  transaction: TenantTransaction,
  input: BookSlotInput,
  eventId: string,
  startsAt: Date,
  participants: { id: string; role: unknown; userId: unknown }[],
) {
  const policy = await findAvailabilityPolicy(transaction, input.organizationId, input.ownerUserId)
  const offsets = policy?.defaultReminderOffsets ?? []
  const channels = policy?.defaultReminderChannels ?? []
  if (offsets.length === 0 || channels.length === 0) return

  const organizer = participants.find((participant) => participant.role === 'organizer')
  const rows = offsets.flatMap((offsetMinutes) => channels.map((channel) => ({
    organizationId: input.organizationId,
    eventId,
    participantId: organizer?.id ?? null,
    channel,
    offsetMinutes,
    nextFireAt: new Date(startsAt.getTime() - offsetMinutes * 60_000),
  })))
  await insertReminders(transaction, rows)
}

export interface CancelBookingInput {
  organizationId: string
  ownerUserId: string
  invitationId: string
  now?: Date
}

/**
 * Cancels a booked interview.
 *
 * History is preserved deliberately: the event moves to `cancelled` rather than being deleted, and
 * the invitation keeps `status = 'booked'` with its `booked_event_id` intact. The invitation status
 * graph has no `cancelled` state and adding one would be wrong — the invitation *was* booked, and
 * that happened. The cancellation is a fact about the appointment, not a rewind of the invitation.
 *
 * Reminders are cancelled in the same transaction, because spec.md requires that they "never resend
 * after event cancellation".
 */
export async function cancelBooking(
  transaction: TenantTransaction,
  input: CancelBookingInput,
): Promise<{ ok: true; eventId: string } | BookingFailure> {
  const invitation = await findInvitationForOwner(
    transaction,
    input.organizationId,
    input.ownerUserId,
    input.invitationId,
  )
  if (!invitation) return fail('invitation_unavailable', 'invitation not found')
  if (invitation.status !== 'booked' || !invitation.bookedEventId) {
    return fail('invitation_unavailable', 'invitation has no booking to cancel')
  }

  const event = await findEventById(transaction, input.organizationId, invitation.bookedEventId)
  if (!event) return fail('invitation_unavailable', 'booked event is gone')
  if (event.status === 'cancelled') {
    // Already cancelled: idempotent, not an error. A candidate pressing cancel twice has not done
    // anything wrong.
    return { ok: true, eventId: invitation.bookedEventId }
  }

  const updated = await updateEventWithVersion(
    transaction,
    input.organizationId,
    input.ownerUserId,
    invitation.bookedEventId,
    event.version as number,
    { status: 'cancelled', busy: false },
  )
  if (!updated) return fail('slot_unavailable', 'the appointment changed while cancelling')

  await cancelRemindersForEvent(transaction, input.organizationId, invitation.bookedEventId)
  return { ok: true, eventId: invitation.bookedEventId }
}

/** A reschedule takes exactly the same input as a first booking: the new slot, plus consent re-asserted. */
export type RescheduleBookingInput = BookSlotInput

/**
 * Moves a booked interview to a new slot.
 *
 * The old event is marked `rescheduled` and a new one is created rather than the start time being
 * edited in place. Two reasons: the `.ics` sequence and the participants' calendar clients need a
 * cancellation for the old occurrence and a request for the new one, and an audit of "when was this
 * interview" has to be able to answer for both. spec.md: "Reschedule creates linked replacement
 * occurrence/event state without a gap or double confirmation."
 *
 * "Without a gap" is why this runs as one transaction under the same advisory lock as a first
 * booking: there is no instant at which the invitation has no appointment, and no window in which
 * the freed slot is visible to another candidate before the replacement is written.
 */
export async function rescheduleBooking(
  transaction: TenantTransaction,
  input: RescheduleBookingInput,
): Promise<BookingResult> {
  const now = input.now ?? new Date()

  const invitation = await findInvitationForOwner(
    transaction,
    input.organizationId,
    input.ownerUserId,
    input.invitationId,
  )
  if (!invitation) return fail('invitation_unavailable', 'invitation not found')
  if (invitation.status !== 'booked' || !invitation.bookedEventId) {
    return fail('invitation_unavailable', 'invitation has no booking to reschedule')
  }

  await lockOrganizerDay(
    transaction,
    input.organizationId,
    input.ownerUserId,
    localDayKey(input.slotStartsAtHint, invitation.timezone),
  )

  const previous = await findEventById(transaction, input.organizationId, invitation.bookedEventId)
  if (!previous) return fail('invitation_unavailable', 'booked event is gone')

  const submission = await findSubmissionByInvitation(transaction, input.organizationId, input.invitationId)
  if (!submission) return fail('invalid_input', 'candidate details are missing')

  // Consent is re-verified rather than inherited: a purpose withdrawn between booking and reschedule
  // must block the new appointment exactly as it would block a first one.
  const consent = await verifyRequiredConsents(transaction, {
    organizationId: input.organizationId,
    invitationId: input.invitationId,
    consentReceiptIds: input.consentReceiptIds,
    requiredPurposes: input.requiredPurposes,
    noticeVersion: input.noticeVersion,
  })
  if (!consent.ok) {
    return fail('consent_required', consent.reason, { missingPurposes: consent.missingPurposes })
  }

  // The old appointment is released before recomputation so the organizer's own outgoing slot does
  // not block the candidate from picking a time that overlaps it — including the same time.
  const released = await updateEventWithVersion(
    transaction,
    input.organizationId,
    input.ownerUserId,
    invitation.bookedEventId,
    previous.version as number,
    { status: 'rescheduled', busy: false },
  )
  if (!released) return fail('slot_unavailable', 'the appointment changed while rescheduling')
  await cancelRemindersForEvent(transaction, input.organizationId, invitation.bookedEventId)

  const recomputed = await recomputeSlots(transaction, input, invitation, now)
  const slot = recomputed.find((candidate) => candidate.slotId === input.slotId)
  if (!slot) {
    // Throwing rather than returning rolls the release back with the rest of the transaction, so a
    // failed reschedule leaves the original appointment exactly as it was.
    throw new BookingConflictError('the chosen time is no longer available', recomputed.slice(0, 10))
  }

  const calendar = await findDefaultCalendar(transaction, input.organizationId, input.ownerUserId)
  if (!calendar) return fail('invalid_input', 'organizer has no default calendar')

  const replacement = await insertEvent(transaction, {
    organizationId: input.organizationId,
    calendarId: calendar.id,
    ownerUserId: input.ownerUserId,
    type: 'interview',
    status: 'confirmed',
    title: `Interview: ${invitation.roleTitle}`,
    location: invitation.location,
    meetingUrl: invitation.meetingUrl,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    timezone: invitation.timezone,
    allDay: false,
    busy: true,
    sourceType: 'scheduling_invitation',
    sourceId: input.invitationId,
  })

  const participants = await insertParticipants(transaction, [
    {
      organizationId: input.organizationId,
      eventId: replacement.id,
      eventOwnerUserId: input.ownerUserId,
      userId: input.ownerUserId,
      role: 'organizer',
      accessGranted: true,
    },
    {
      organizationId: input.organizationId,
      eventId: replacement.id,
      eventOwnerUserId: input.ownerUserId,
      externalEmail: submission.emailNormalized,
      displayName: submission.displayName,
      role: 'attendee',
      accessGranted: false,
    },
  ])
  await armReminders(transaction, input, replacement.id, slot.startsAt, participants)

  const marked = await updateInvitationStateWithVersion(
    transaction,
    input.organizationId,
    input.ownerUserId,
    input.invitationId,
    invitation.version,
    {
      bookedEventId: replacement.id,
      bookedAt: now,
      rescheduleCount: invitation.rescheduleCount + 1,
    },
  )
  if (!marked) throw new Error('invitation version changed while rescheduling under an advisory lock')

  return {
    ok: true,
    eventId: replacement.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    timezone: invitation.timezone,
    alreadyBooked: false,
    candidate: { displayName: submission.displayName, email: submission.emailNormalized },
  }
}

/**
 * Thrown when a reschedule cannot land on the requested slot.
 *
 * A throw rather than a returned failure, because by that point the transaction has already released
 * the old appointment: the only correct outcome is a rollback, and returning a value would let a
 * caller commit a booking-less invitation. Carries the alternatives so the route can still answer
 * with `409 slot_unavailable` plus refreshed times.
 */
export class BookingConflictError extends Error {
  readonly code = 'slot_unavailable' as const
  constructor(message: string, readonly alternatives: { slotId: string; startsAt: Date; endsAt: Date }[]) {
    super(message)
    this.name = 'BookingConflictError'
  }
}
