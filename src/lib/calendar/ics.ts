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
 * Three properties carry all the weight:
 *  - **UID** is derived from the event id and never changes, so a later CANCEL matches the
 *    original REQUEST instead of being filed as an unrelated cancellation for an unknown event.
 *  - **SEQUENCE** comes from the event's optimistic `version`, which only ever increases. A client
 *    ignores an update whose SEQUENCE is not higher than what it already holds, so reusing or
 *    lowering it would make edits silently invisible.
 *  - **Instants are emitted in UTC** (`DTSTART:...Z`), never as a local time plus `TZID`.
 *
 * That last one is not a style choice. Passing `timezone` to `ical-generator` labels the value with
 * `TZID=` but formats the wall-clock in the *process's* timezone, and it emits no `VTIMEZONE` block
 * for a client to resolve the label against. So a 09:00Z interview was written as
 * `DTSTART;TZID=Europe/Copenhagen:20270504T090000` on a UTC server -- two hours early on every
 * attendee's calendar -- and as `...T110000`, correctly, on a machine already in Copenhagen. It
 * therefore passed locally and produced wrong invitations in production, which is the worst shape a
 * bug of this kind can take.
 *
 * UTC has none of that ambiguity: it needs no `VTIMEZONE`, cannot drift with the server's `TZ`, and
 * every client renders it in the viewer's own zone -- which is what you want for an interview between
 * two people in different countries. `input.timezone` stays on the input because our own UI renders
 * with it; it is deliberately not handed to the generator. If a future event needs recurrence, that
 * is when local-time-plus-`TZID` becomes necessary, and it will need a real `VTIMEZONE` with it.
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
      summary: input.title,
      description: input.description ?? undefined,
      location: input.meetingUrl ?? input.location ?? undefined,
      url: input.meetingUrl ?? undefined,
    })
  }
  return calendar.toString()
}
