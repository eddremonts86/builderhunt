import icalGenerator, { ICalCalendarMethod, ICalEventStatus } from 'ical-generator'
import { icsSequenceForEvent, icsUidForEvent } from './service'

/**
 * RFC 5545 emission for calendar events (plan: calendar-scheduling-interview-intelligence,
 * Phase 3).
 *
 * Shared between the reminder worker (which mails REQUEST/CANCEL updates) and the private ICS
 * export route, because both must agree on UID and SEQUENCE. If they disagreed, a calendar client
 * would treat the exported event and the mailed update as two different entries and the user would
 * end up with duplicates that never reconcile.
 *
 * Two properties carry all the weight:
 *  - **UID** is derived from the event id and never changes, so a later CANCEL matches the
 *    original REQUEST instead of being filed as an unrelated cancellation for an unknown event.
 *  - **SEQUENCE** comes from the event's optimistic `version`, which only ever increases. A client
 *    ignores an update whose SEQUENCE is not higher than what it already holds, so reusing or
 *    lowering it would make edits silently invisible.
 */

export interface IcsEventInput {
  eventId: string
  version: number
  title: string
  description?: string | null
  startsAt: Date
  endsAt: Date
  timezone: string
  location?: string | null
  meetingUrl?: string | null
  organizerEmail?: string | null
  organizerName?: string | null
  attendees?: { email: string; name?: string | null }[]
}

export type IcsMethod = 'REQUEST' | 'CANCEL'

export function buildEventIcs(input: IcsEventInput, method: IcsMethod): string {
  const calendar = icalGenerator({
    name: 'BuilderHunt',
    prodId: { company: 'BuilderHunt', product: 'Calendar', language: 'EN' },
    method: method === 'CANCEL' ? ICalCalendarMethod.CANCEL : ICalCalendarMethod.REQUEST,
  })

  const event = calendar.createEvent({
    id: icsUidForEvent(input.eventId),
    sequence: icsSequenceForEvent(input.version),
    start: input.startsAt,
    end: input.endsAt,
    timezone: input.timezone,
    summary: input.title,
    description: input.description ?? undefined,
    // A meeting URL is the more useful LOCATION for a remote call; a client renders it as a
    // tappable join target, which a physical address field would not be.
    location: input.meetingUrl ?? input.location ?? undefined,
    url: input.meetingUrl ?? undefined,
    status: method === 'CANCEL' ? ICalEventStatus.CANCELLED : ICalEventStatus.CONFIRMED,
  })

  if (input.organizerEmail) {
    event.organizer({ name: input.organizerName ?? input.organizerEmail, email: input.organizerEmail })
  }
  for (const attendee of input.attendees ?? []) {
    event.createAttendee({ email: attendee.email, name: attendee.name ?? undefined })
  }

  return calendar.toString()
}

/** Bounded multi-event export for the private ICS feed — always PUBLISH, never a scheduling request. */
export function buildCalendarIcs(events: IcsEventInput[]): string {
  const calendar = icalGenerator({
    name: 'BuilderHunt',
    prodId: { company: 'BuilderHunt', product: 'Calendar', language: 'EN' },
    method: ICalCalendarMethod.PUBLISH,
  })
  for (const input of events) {
    calendar.createEvent({
      id: icsUidForEvent(input.eventId),
      sequence: icsSequenceForEvent(input.version),
      start: input.startsAt,
      end: input.endsAt,
      timezone: input.timezone,
      summary: input.title,
      description: input.description ?? undefined,
      location: input.meetingUrl ?? input.location ?? undefined,
      url: input.meetingUrl ?? undefined,
    })
  }
  return calendar.toString()
}
