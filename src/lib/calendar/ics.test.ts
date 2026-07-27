import ical, { type VEvent } from 'node-ical'
import { describe, expect, it } from 'vitest'
import { buildCalendarIcs, buildEventIcs, type IcsEventInput } from './ics'

/**
 * These tests parse our output with `node-ical` rather than string-matching it.
 *
 * The distinction matters: a regex over the raw text confirms we emitted some characters, while a
 * parser confirms a standards-compliant calendar client can actually read them. Line folding at 75
 * octets, CRLF endings, property escaping, and VTIMEZONE placement are all things a regex sails
 * past and a parser does not.
 */

const BASE: IcsEventInput = {
  eventId: '2f1a6e10-2e0e-4a0e-9e2b-1c4c9a5a11f0',
  version: 1,
  title: 'Interview with Ada',
  description: 'First round, 30 minutes',
  startsAt: new Date('2027-05-04T09:00:00.000Z'),
  endsAt: new Date('2027-05-04T09:30:00.000Z'),
  timezone: 'Europe/Copenhagen',
  meetingUrl: 'https://meet.example.invalid/abc',
  organizerEmail: 'organizer@test.invalid',
  organizerName: 'Organizer',
  attendees: [{ email: 'ada@test.invalid', name: 'Ada' }],
}

function parseEvents(icsText: string): VEvent[] {
  const parsed = ical.sync.parseICS(icsText)
  return Object.values(parsed).filter((entry): entry is VEvent => entry?.type === 'VEVENT')
}

function parseSingleEvent(icsText: string): VEvent {
  const events = parseEvents(icsText)
  expect(events).toHaveLength(1)
  return events[0]
}

describe('buildEventIcs — REQUEST', () => {
  it('parses as a standards-compliant calendar with the expected event', () => {
    const event = parseSingleEvent(buildEventIcs(BASE, 'REQUEST'))

    expect(event.summary).toBe('Interview with Ada')
    expect(event.start.getTime()).toBe(BASE.startsAt.getTime())
    expect(event.end?.getTime()).toBe(BASE.endsAt.getTime())
    expect(event.status).toBe('CONFIRMED')
  })

  it('emits instants in UTC, so the server timezone cannot shift the appointment', () => {
    // This is the assertion the previous version of this file lacked. The round-trip check above
    // compares parsed instants, and `node-ical` resolves a bare `TZID=` label using the *process's*
    // timezone — so on a machine already in Europe/Copenhagen a wrong `DTSTART` and a wrong
    // interpretation cancelled out and the test passed. It failed only in CI, under TZ=UTC, after
    // three days of the workflow being unable to run at all.
    //
    // Pinning the wire format instead of the round-trip removes the coincidence: `...Z` is correct
    // under every `TZ`, and needs no `VTIMEZONE` block for a client to resolve.
    const text = buildEventIcs(BASE, 'REQUEST')
    expect(text).toContain('DTSTART:20270504T090000Z')
    expect(text).toContain('DTEND:20270504T093000Z')
    expect(text).not.toContain('TZID=')
  })

  it('carries METHOD:REQUEST so a client treats it as a scheduling request', () => {
    expect(buildEventIcs(BASE, 'REQUEST')).toContain('METHOD:REQUEST')
  })

  it('folds and escapes text the parser can recover verbatim', () => {
    // A long title with a comma and a semicolon: both are RFC 5545 delimiters that must be escaped,
    // and the length forces line folding. A client that reads back the original string proves both.
    const awkward = `Deep dive; architecture, scaling, and the ${'very '.repeat(20)}long tail`
    const event = parseSingleEvent(buildEventIcs({ ...BASE, title: awkward }, 'REQUEST'))
    expect(event.summary).toBe(awkward)
  })
})

describe('buildEventIcs — CANCEL', () => {
  it('cancels the SAME event, matched by UID', () => {
    const request = parseSingleEvent(buildEventIcs(BASE, 'REQUEST'))
    const cancel = parseSingleEvent(buildEventIcs({ ...BASE, version: 2 }, 'CANCEL'))

    // This is the whole point of a derived UID: without it the client files the cancellation as an
    // unrelated event and the original stays in the calendar forever.
    expect(cancel.uid).toBe(request.uid)
    expect(cancel.status).toBe('CANCELLED')
    expect(buildEventIcs({ ...BASE, version: 2 }, 'CANCEL')).toContain('METHOD:CANCEL')
  })

  it('raises SEQUENCE so the cancellation supersedes the request', () => {
    const request = parseSingleEvent(buildEventIcs(BASE, 'REQUEST'))
    const cancel = parseSingleEvent(buildEventIcs({ ...BASE, version: 4 }, 'CANCEL'))

    // A client ignores an update whose SEQUENCE is not higher than what it holds, so a
    // non-increasing value would make the cancellation silently invisible.
    expect(Number(cancel.sequence)).toBeGreaterThan(Number(request.sequence))
  })
})

describe('buildCalendarIcs — export feed', () => {
  it('emits PUBLISH and one VEVENT per event, each with its own UID', () => {
    const second = { ...BASE, eventId: '8b3d5a20-1111-4a0e-9e2b-1c4c9a5a11f0', title: 'Second' }
    const text = buildCalendarIcs([BASE, second])
    const events = parseEvents(text)

    expect(text).toContain('METHOD:PUBLISH')
    expect(events).toHaveLength(2)
    expect(new Set(events.map((event) => event.uid)).size).toBe(2)
  })
})
