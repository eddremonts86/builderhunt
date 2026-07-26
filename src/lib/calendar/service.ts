import { createHash } from 'node:crypto'
import type { TenantTransaction } from '~/shared/lib/db/client'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { can } from '~/shared/lib/authorization/permissions'
import {
  assertMatchingEventVersion,
  assertSupportedRecurrenceRule,
  assertValidEventStatusTransition,
  CalendarEventError,
  rangesOverlap,
  resolveRecurrenceMutationPlan,
  type CalendarEventStatus,
  type RecurrenceMutationScope,
} from '~/shared/lib/calendar'
import {
  cancelRemindersForEvent,
  countUnreadDeliveries,
  deleteEventWithVersion,
  deleteOccurrencesForEvent,
  findEventById,
  hasGrantedParticipation,
  insertEvent,
  insertParticipants,
  insertReminders,
  listOwnDeliveries,
  markDeliveriesRead,
  rearmRemindersForEvent,
  listBusyRanges,
  listEventsInRange,
  listParticipants,
  searchEvents,
  updateEventWithVersion,
} from '~/shared/lib/repositories/calendar'

/**
 * Calendar orchestration and authorization (plan: calendar-scheduling-interview-intelligence,
 * Phase 3 "Implement calendar service and authorization").
 *
 * This is the single place that decides who may do what to a calendar event. Routes call these
 * functions; they never combine repository calls and permission checks themselves. The three
 * enforcement layers stack deliberately: `can()` here (product rules), owner/version predicates in
 * the repository (defense in depth), and RLS in Postgres (the backstop). A bug in any one of them
 * is caught by the other two.
 */

export class CalendarServiceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'CalendarServiceError'
  }
}

/**
 * Resolves the caller's relationship to an event once, so every downstream check uses the same
 * answer. Returns `null` when the event does not exist *or* the caller may not see it — the two
 * are indistinguishable to the caller by design, so a probe cannot confirm an event's existence.
 */
async function resolveEventAccess(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  eventId: string,
) {
  const event = await findEventById(transaction, principal.organizationId, eventId)
  if (!event) return null

  const isGrantedParticipant = event.ownerUserId === principal.userId
    ? true
    : await hasGrantedParticipation(transaction, principal.organizationId, eventId, principal.userId)

  const context = { creatorUserId: event.ownerUserId, isGrantedParticipant }
  if (!can(principal, 'calendar:read', context)) return null

  return { event, context }
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

export async function getEvent(transaction: TenantTransaction, principal: TenantPrincipal, eventId: string) {
  const access = await resolveEventAccess(transaction, principal, eventId)
  if (!access) return null
  return {
    event: access.event,
    participants: await listParticipants(transaction, principal.organizationId, eventId),
    editable: can(principal, 'calendar:mutate', access.context),
  }
}

export async function listRange(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  range: { from: Date; to: Date },
) {
  if (range.to <= range.from) {
    throw new CalendarServiceError('to must be after from', 'invalid_input')
  }
  return listEventsInRange(transaction, principal.organizationId, principal.userId, range)
}

export async function search(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  filter: { title?: string; participant?: string; eventType?: string; from: Date; to: Date },
) {
  if (filter.to <= filter.from) {
    throw new CalendarServiceError('to must be after from', 'invalid_input')
  }
  return searchEvents(transaction, principal.organizationId, principal.userId, filter)
}

// ── Overlap policy (spec.md "Complete calendar behavior") ───────────────────────────────────
// "Overlap is allowed for manual personal events after a warning; confirmed interview booking
// treats busy overlap as a hard conflict."

export type OverlapVerdict =
  | { kind: 'clear' }
  | { kind: 'warning'; conflictCount: number }
  | { kind: 'conflict'; conflictCount: number }

export async function evaluateOverlap(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  candidate: { startsAt: Date; endsAt: Date; type: string; busy: boolean; excludeEventId?: string },
): Promise<OverlapVerdict> {
  if (!candidate.busy) return { kind: 'clear' }

  const busy = await listBusyRanges(transaction, principal.organizationId, principal.userId, {
    from: candidate.startsAt,
    to: candidate.endsAt,
  })
  // The event being moved must not conflict with its own current position.
  const others = candidate.excludeEventId
    ? busy.filter((range) => range.start.getTime() !== candidate.startsAt.getTime() || range.end.getTime() !== candidate.endsAt.getTime())
    : busy
  const conflicts = others.filter((range) => rangesOverlap(candidate.startsAt, candidate.endsAt, range.start, range.end))

  if (conflicts.length === 0) return { kind: 'clear' }
  return candidate.type === 'interview'
    ? { kind: 'conflict', conflictCount: conflicts.length }
    : { kind: 'warning', conflictCount: conflicts.length }
}

// ── Create ───────────────────────────────────────────────────────────────────────────────────

export interface CreateEventInput {
  calendarId: string
  type: string
  title: string
  description?: string | null
  location?: string | null
  meetingUrl?: string | null
  startsAt: Date
  endsAt: Date
  timezone: string
  allDay: boolean
  busy: boolean
  rrule?: string | null
  recurrenceUntil?: Date | null
  reminders?: { channel: string; offsetMinutes: number }[]
  participants?: { userId?: string | null; externalEmail?: string | null; displayName?: string | null; role: string }[]
  /** Set by the caller after showing the user the overlap warning; ignored for interview events, which never soften a conflict. */
  acknowledgeOverlapWarning?: boolean
}

export async function createEvent(transaction: TenantTransaction, principal: TenantPrincipal, input: CreateEventInput) {
  if (input.endsAt <= input.startsAt) {
    throw new CalendarServiceError('endsAt must be after startsAt', 'invalid_input')
  }
  if (input.rrule) assertSupportedRecurrenceRule(input.rrule)

  const overlap = await evaluateOverlap(transaction, principal, {
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    type: input.type,
    busy: input.busy,
  })
  if (overlap.kind === 'conflict') {
    throw new CalendarServiceError('This time conflicts with an existing booking', 'slot_unavailable')
  }
  if (overlap.kind === 'warning' && !input.acknowledgeOverlapWarning) {
    throw new CalendarServiceError('This time overlaps an existing event', 'overlap_warning')
  }

  const event = await insertEvent(transaction, {
    organizationId: principal.organizationId,
    calendarId: input.calendarId,
    ownerUserId: principal.userId,
    type: input.type,
    // Every event starts `scheduled`; reaching `confirmed` is a transition, never an initial value.
    status: 'scheduled',
    title: input.title,
    description: input.description,
    location: input.location,
    meetingUrl: input.meetingUrl,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    timezone: input.timezone,
    allDay: input.allDay,
    busy: input.busy,
    rrule: input.rrule,
    recurrenceUntil: input.recurrenceUntil,
  })

  if (input.participants?.length) {
    await insertParticipants(transaction, input.participants.map((participant) => ({
      organizationId: principal.organizationId,
      eventId: event.id,
      eventOwnerUserId: principal.userId,
      userId: participant.userId ?? null,
      externalEmail: participant.externalEmail ?? null,
      displayName: participant.displayName ?? null,
      role: participant.role,
      // Internal users get read access; an external contact has no BuilderHunt account to read with.
      accessGranted: Boolean(participant.userId),
    })))
  }

  if (input.reminders?.length) {
    await insertReminders(transaction, input.reminders.map((reminder) => ({
      organizationId: principal.organizationId,
      eventId: event.id,
      channel: reminder.channel,
      offsetMinutes: reminder.offsetMinutes,
      nextFireAt: new Date(input.startsAt.getTime() - reminder.offsetMinutes * 60_000),
    })))
  }

  return { event, overlapWarning: overlap.kind === 'warning' ? overlap.conflictCount : 0 }
}

// ── Update / move / resize ───────────────────────────────────────────────────────────────────

export interface UpdateEventInput {
  version: number
  recurrenceScope?: RecurrenceMutationScope
  recurrenceId?: string | null
  patch: Partial<{
    title: string
    description: string | null
    location: string | null
    meetingUrl: string | null
    startsAt: Date
    endsAt: Date
    timezone: string
    allDay: boolean
    busy: boolean
    rrule: string | null
    recurrenceUntil: Date | null
  }>
  acknowledgeOverlapWarning?: boolean
}

export async function updateEvent(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  eventId: string,
  input: UpdateEventInput,
) {
  const access = await resolveEventAccess(transaction, principal, eventId)
  if (!access) throw new CalendarServiceError('Event not found', 'not_found')
  if (!can(principal, 'calendar:mutate', access.context)) {
    throw new CalendarServiceError('Only the event owner can change this event', 'forbidden')
  }

  const { event } = access
  assertMatchingEventVersion(event.version, input.version)

  // spec.md: "source pair null together" — an event created from an invitation cannot be
  // re-pointed or detached by an ordinary edit.
  if (event.sourceType !== null && (input.patch.startsAt || input.patch.endsAt)) {
    throw new CalendarServiceError(
      'This event is managed by its scheduling invitation — reschedule it there instead',
      'state_changed',
    )
  }

  const startsAt = input.patch.startsAt ?? event.startsAt
  const endsAt = input.patch.endsAt ?? event.endsAt
  if (endsAt <= startsAt) {
    throw new CalendarServiceError('endsAt must be after startsAt', 'invalid_input')
  }
  if (input.patch.rrule) assertSupportedRecurrenceRule(input.patch.rrule)

  // A recurring event always needs an explicit scope, so a user never silently edits a whole
  // series when they meant one occurrence.
  if (event.rrule && !input.recurrenceScope) {
    throw new CalendarServiceError('A recurring event edit must state its scope', 'invalid_input')
  }
  const plan = event.rrule
    ? resolveRecurrenceMutationPlan({ scope: input.recurrenceScope!, recurrenceId: input.recurrenceId ?? null })
    : null

  if (input.patch.startsAt || input.patch.endsAt || input.patch.busy !== undefined) {
    const overlap = await evaluateOverlap(transaction, principal, {
      startsAt,
      endsAt,
      type: event.type,
      busy: input.patch.busy ?? event.busy,
      excludeEventId: eventId,
    })
    if (overlap.kind === 'conflict') {
      throw new CalendarServiceError('This time conflicts with an existing booking', 'slot_unavailable')
    }
    if (overlap.kind === 'warning' && !input.acknowledgeOverlapWarning) {
      throw new CalendarServiceError('This time overlaps an existing event', 'overlap_warning')
    }
  }

  const updated = await updateEventWithVersion(
    transaction,
    principal.organizationId,
    principal.userId,
    eventId,
    input.version,
    input.patch,
  )
  // The version matched when we read it but not when we wrote it — someone committed in between.
  if (!updated) throw new CalendarEventError('Event was modified concurrently', 'event_changed')

  // Any timing or recurrence change invalidates the materialized occurrences; the worker
  // rebuilds them on its next pass.
  if (input.patch.startsAt || input.patch.endsAt || input.patch.rrule !== undefined || input.patch.recurrenceUntil !== undefined) {
    await deleteOccurrencesForEvent(transaction, principal.organizationId, eventId)
  }

  // Reminders store an absolute `nextFireAt` derived from the start, so a moved start has to
  // re-derive it. Skipping this leaves reminders firing against the event's previous schedule.
  if (input.patch.startsAt) {
    await rearmRemindersForEvent(transaction, principal.organizationId, eventId, input.patch.startsAt)
  }

  return { event: updated, recurrencePlan: plan }
}

// ── Status transitions, cancel, delete ───────────────────────────────────────────────────────

export async function transitionEventStatus(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  eventId: string,
  version: number,
  to: CalendarEventStatus,
) {
  const access = await resolveEventAccess(transaction, principal, eventId)
  if (!access) throw new CalendarServiceError('Event not found', 'not_found')
  if (!can(principal, 'calendar:mutate', access.context)) {
    throw new CalendarServiceError('Only the event owner can change this event', 'forbidden')
  }

  assertMatchingEventVersion(access.event.version, version)
  assertValidEventStatusTransition(access.event.status as CalendarEventStatus, to)

  const updated = await updateEventWithVersion(transaction, principal.organizationId, principal.userId, eventId, version, {
    status: to,
    cancelledAt: to === 'cancelled' ? new Date() : null,
  })
  if (!updated) throw new CalendarEventError('Event was modified concurrently', 'event_changed')

  // spec.md: reminders "never resend after event cancellation".
  if (to === 'cancelled') {
    await cancelRemindersForEvent(transaction, principal.organizationId, eventId)
  }
  return updated
}

/**
 * Cancel keeps the row (and its history, participants, and `.ics` UID) and stops future
 * reminders. Delete removes it outright. spec.md treats these as distinct user intents, so the
 * service exposes both rather than overloading one.
 */
export async function cancelEvent(transaction: TenantTransaction, principal: TenantPrincipal, eventId: string, version: number) {
  return transitionEventStatus(transaction, principal, eventId, version, 'cancelled')
}

export async function deleteEvent(transaction: TenantTransaction, principal: TenantPrincipal, eventId: string, version: number) {
  const access = await resolveEventAccess(transaction, principal, eventId)
  if (!access) throw new CalendarServiceError('Event not found', 'not_found')
  if (!can(principal, 'calendar:mutate', access.context)) {
    throw new CalendarServiceError('Only the event owner can delete this event', 'forbidden')
  }
  assertMatchingEventVersion(access.event.version, version)

  await cancelRemindersForEvent(transaction, principal.organizationId, eventId)
  const deleted = await deleteEventWithVersion(transaction, principal.organizationId, principal.userId, eventId, version)
  if (!deleted) throw new CalendarEventError('Event was modified concurrently', 'event_changed')
  return deleted
}

// ── ICS identity (spec.md: "stable UID and increasing SEQUENCE") ────────────────────────────

/**
 * Derived from the event id, so the UID an external calendar sees is stable across every update
 * and cancellation for the life of the event — a `CANCEL` must reference the same UID as the
 * original `REQUEST` or the recipient's calendar will not match them up.
 */
export function icsUidForEvent(eventId: string): string {
  return `${createHash('sha256').update(eventId).digest('hex').slice(0, 32)}@builderhunt.dev`
}

/** SEQUENCE must increase monotonically; the event's own optimistic version already does. */
export function icsSequenceForEvent(version: number): number {
  return version - 1
}

// ── Notification deliveries ──────────────────────────────────────────────────────────────────

/**
 * The caller's own notification feed (plan Phase 3, "Add calendar event APIs").
 *
 * There is deliberately no `can()` call here and no admin path. Ownership is not a permission
 * question for this resource — a delivery belongs to exactly one recipient, and the repository
 * filters on `recipientUserId = principal.userId`. Adding an elevation branch would be the only
 * way to make an org admin able to read someone else's notifications, so there isn't one.
 */
export async function listOwnNotifications(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: { limit: number; cursor?: { createdAt: Date; id: string } | null },
) {
  // Fetch one extra row to learn whether another page exists without a second COUNT query.
  const rows = await listOwnDeliveries(transaction, principal.organizationId, principal.userId, input.limit + 1, input.cursor ?? null)
  const page = rows.slice(0, input.limit)
  const last = rows.length > input.limit ? page[page.length - 1] : null
  return {
    deliveries: page,
    nextCursor: last ? { createdAt: last.createdAt, id: last.id } : null,
  }
}

export async function countOwnUnreadNotifications(transaction: TenantTransaction, principal: TenantPrincipal) {
  return countUnreadDeliveries(transaction, principal.organizationId, principal.userId)
}

/**
 * Marks an explicit list of the caller's own deliveries read.
 *
 * Takes IDs rather than offering "mark all read" on purpose: the repository re-filters on
 * `recipientUserId`, so an id belonging to someone else simply matches nothing and is returned as
 * unaffected. The caller learns which ids actually changed, and never whether an id it does not
 * own exists.
 */
export async function markOwnNotificationsRead(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  deliveryIds: string[],
) {
  const updated = await markDeliveriesRead(transaction, principal.organizationId, principal.userId, deliveryIds)
  return { markedIds: updated.map((row) => row.id) }
}
