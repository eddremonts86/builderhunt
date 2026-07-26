import { describe, expect, it } from 'vitest'
import {
  assertMatchingEventVersion,
  assertSupportedRecurrenceRule,
  assertValidEventStatusTransition,
  CALENDAR_EVENT_STATUSES,
  CalendarEventError,
  calendarExportFilterSchema,
  calendarFeedItemSchema,
  calendarSearchFilterSchema,
  eventOccurrenceSchema,
  eventParticipantSchema,
  eventSchema,
  isSupportedReminderOffset,
  rangesOverlap,
  resolveRecurrenceMutationPlan,
  toEventParticipantPublicDto,
  type CalendarEventStatus,
} from './calendar'

const VALID_EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  calendarId: '22222222-2222-4222-8222-222222222222',
  ownerUserId: 'user-1',
  type: 'personal' as const,
  status: 'scheduled' as const,
  title: 'Standup',
  description: null,
  location: null,
  meetingUrl: null,
  startsAt: '2026-08-01T09:00:00.000Z',
  endsAt: '2026-08-01T09:30:00.000Z',
  timezone: 'Europe/Copenhagen',
  allDay: false,
  busy: true,
  visibility: 'private' as const,
  rrule: null,
  recurrenceUntil: null,
  version: 1,
  sourceType: null,
  sourceId: null,
  cancelledAt: null,
}

describe('event status transitions', () => {
  const VALID_TRANSITIONS: [CalendarEventStatus, CalendarEventStatus][] = [
    ['scheduled', 'confirmed'],
    ['scheduled', 'cancelled'],
    ['confirmed', 'in_progress'],
    ['confirmed', 'cancelled'],
    ['confirmed', 'rescheduled'],
    ['confirmed', 'no_show'],
    ['in_progress', 'completed'],
    ['in_progress', 'cancelled'],
  ]

  it.each(VALID_TRANSITIONS)('allows %s -> %s', (from, to) => {
    expect(() => assertValidEventStatusTransition(from, to)).not.toThrow()
  })

  const allPairs: [CalendarEventStatus, CalendarEventStatus][] = CALENDAR_EVENT_STATUSES.flatMap((from) =>
    CALENDAR_EVENT_STATUSES.map((to) => [from, to] as [CalendarEventStatus, CalendarEventStatus]),
  )
  const invalidPairs = allPairs.filter(
    ([from, to]) => !VALID_TRANSITIONS.some(([validFrom, validTo]) => validFrom === from && validTo === to),
  )

  it.each(invalidPairs)('rejects %s -> %s', (from, to) => {
    expect(() => assertValidEventStatusTransition(from, to)).toThrow(CalendarEventError)
  })

  it('every terminal status rejects every transition, including to itself', () => {
    for (const terminal of ['completed', 'cancelled', 'rescheduled', 'no_show'] as const) {
      for (const to of CALENDAR_EVENT_STATUSES) {
        expect(() => assertValidEventStatusTransition(terminal, to)).toThrow()
      }
    }
  })
})

describe('optimistic version (stale write mapping)', () => {
  it('accepts a matching version', () => {
    expect(() => assertMatchingEventVersion(3, 3)).not.toThrow()
  })

  it('throws a coded event_changed error on mismatch', () => {
    try {
      assertMatchingEventVersion(4, 3)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarEventError)
      expect((error as CalendarEventError).code).toBe('event_changed')
    }
  })
})

describe('eventSchema', () => {
  it('accepts a valid event', () => {
    expect(() => eventSchema.parse(VALID_EVENT)).not.toThrow()
  })

  it('rejects endsAt not after startsAt (invalid range)', () => {
    expect(() => eventSchema.parse({ ...VALID_EVENT, endsAt: VALID_EVENT.startsAt })).toThrow()
    expect(() => eventSchema.parse({ ...VALID_EVENT, endsAt: '2026-08-01T08:00:00.000Z' })).toThrow()
  })

  it('rejects sourceType/sourceId set independently', () => {
    expect(() => eventSchema.parse({ ...VALID_EVENT, sourceType: 'scheduling_invitation', sourceId: null })).toThrow()
    expect(() => eventSchema.parse({ ...VALID_EVENT, sourceType: null, sourceId: 'abc' })).toThrow()
  })

  it('accepts sourceType/sourceId set together', () => {
    expect(() => eventSchema.parse({ ...VALID_EVENT, sourceType: 'scheduling_invitation', sourceId: 'inv-1' })).not.toThrow()
  })

  it('rejects a visibility value other than private', () => {
    expect(() => eventSchema.parse({ ...VALID_EVENT, visibility: 'public' })).toThrow()
  })

  it('rejects an unexpected extra field (.strict())', () => {
    expect(() => eventSchema.parse({ ...VALID_EVENT, notAField: true })).toThrow()
  })
})

describe('eventOccurrenceSchema', () => {
  const VALID_OCCURRENCE = {
    id: VALID_EVENT.id,
    eventId: VALID_EVENT.id,
    recurrenceId: '2026-08-01',
    startsAt: VALID_EVENT.startsAt,
    endsAt: VALID_EVENT.endsAt,
    status: 'active' as const,
    materializationVersion: 1,
  }

  it('accepts a valid occurrence', () => {
    expect(() => eventOccurrenceSchema.parse(VALID_OCCURRENCE)).not.toThrow()
  })

  it('rejects an invalid range', () => {
    expect(() => eventOccurrenceSchema.parse({ ...VALID_OCCURRENCE, endsAt: VALID_OCCURRENCE.startsAt })).toThrow()
  })
})

describe('participant DTO minimization', () => {
  const INTERNAL_PARTICIPANT = eventParticipantSchema.parse({
    id: VALID_EVENT.id,
    eventId: VALID_EVENT.id,
    identity: { kind: 'internal', userId: 'user-2' },
    displayName: 'Jamie',
    role: 'attendee',
    response: 'accepted',
    accessGranted: true,
    respondedAt: null,
  })

  const EXTERNAL_PARTICIPANT = eventParticipantSchema.parse({
    id: VALID_EVENT.id,
    eventId: VALID_EVENT.id,
    identity: { kind: 'external', externalEmail: 'candidate@example.com' },
    displayName: 'Candidate',
    role: 'attendee',
    response: 'needs_action',
    accessGranted: false,
    respondedAt: null,
  })

  it('strips identity (userId/externalEmail) and eventId from the public DTO', () => {
    const dto = toEventParticipantPublicDto(EXTERNAL_PARTICIPANT)
    expect(dto).toEqual({ displayName: 'Candidate', role: 'attendee', response: 'needs_action' })
    expect(dto).not.toHaveProperty('identity')
    expect(JSON.stringify(dto)).not.toContain('candidate@example.com')
  })

  it('also minimizes an internal participant identically', () => {
    const dto = toEventParticipantPublicDto(INTERNAL_PARTICIPANT)
    expect(dto).toEqual({ displayName: 'Jamie', role: 'attendee', response: 'accepted' })
    expect(JSON.stringify(dto)).not.toContain('user-2')
  })

  it('requires exactly one identity form at the schema level', () => {
    expect(() =>
      eventParticipantSchema.parse({
        id: VALID_EVENT.id,
        eventId: VALID_EVENT.id,
        identity: { kind: 'internal', userId: 'user-2', externalEmail: 'x@example.com' },
        displayName: null,
        role: 'attendee',
        response: 'needs_action',
        accessGranted: true,
        respondedAt: null,
      }),
    ).toThrow()
  })
})

describe('reminder offsets', () => {
  it.each([0, 5, 10, 15, 30, 60, 1440, 10080])('accepts %d minutes', (minutes) => {
    expect(isSupportedReminderOffset(minutes)).toBe(true)
  })

  it.each([1, 20, 90, -5])('rejects %d minutes', (minutes) => {
    expect(isSupportedReminderOffset(minutes)).toBe(false)
  })
})

describe('rangesOverlap (half-open)', () => {
  const d = (s: string) => new Date(s)

  it('detects a genuine overlap', () => {
    expect(rangesOverlap(d('2026-08-01T09:00:00Z'), d('2026-08-01T10:00:00Z'), d('2026-08-01T09:30:00Z'), d('2026-08-01T10:30:00Z'))).toBe(true)
  })

  it('treats back-to-back ranges as non-overlapping (half-open)', () => {
    expect(rangesOverlap(d('2026-08-01T09:00:00Z'), d('2026-08-01T10:00:00Z'), d('2026-08-01T10:00:00Z'), d('2026-08-01T11:00:00Z'))).toBe(false)
  })

  it('detects no overlap when ranges are far apart', () => {
    expect(rangesOverlap(d('2026-08-01T09:00:00Z'), d('2026-08-01T10:00:00Z'), d('2026-08-02T09:00:00Z'), d('2026-08-02T10:00:00Z'))).toBe(false)
  })
})

describe('recurrence rule validation', () => {
  it.each([
    'FREQ=DAILY',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=12',
    'FREQ=YEARLY;INTERVAL=2;UNTIL=20301231T000000Z',
  ])('accepts supported rule %s', (rule) => {
    expect(() => assertSupportedRecurrenceRule(rule)).not.toThrow()
  })

  it.each([
    'FREQ=SECONDLY',
    'FREQ=HOURLY',
    'FREQ=WEEKLY;BYSETPOS=1',
    'FREQ=WEEKLY;BYWEEKNO=3',
    'BYDAY=MO',
    '',
    'garbage',
    'FREQ=WEEKLY;UNTIL=not-a-date',
  ])('rejects unsupported/invalid rule %s (never approximates)', (rule) => {
    expect(() => assertSupportedRecurrenceRule(rule)).toThrow(CalendarEventError)
  })
})

describe('recurrence mutation split guard', () => {
  it('this requires a recurrenceId and creates a single-occurrence exception', () => {
    expect(resolveRecurrenceMutationPlan({ scope: 'this', recurrenceId: '2026-08-01' })).toEqual({
      kind: 'single_occurrence_exception',
      recurrenceId: '2026-08-01',
    })
  })

  it('following requires a recurrenceId and truncates + links a successor', () => {
    expect(resolveRecurrenceMutationPlan({ scope: 'following', recurrenceId: '2026-08-01' })).toEqual({
      kind: 'truncate_and_link_successor',
      recurrenceId: '2026-08-01',
    })
  })

  it('series rematerializes without needing a recurrenceId', () => {
    expect(resolveRecurrenceMutationPlan({ scope: 'series', recurrenceId: null })).toEqual({ kind: 'rematerialize_series' })
  })

  it.each(['this', 'following'] as const)('%s throws without a recurrenceId', (scope) => {
    expect(() => resolveRecurrenceMutationPlan({ scope, recurrenceId: null })).toThrow(CalendarEventError)
  })
})

describe('search and export filters', () => {
  it('accepts a valid search filter', () => {
    expect(() =>
      calendarSearchFilterSchema.parse({ title: 'standup', eventType: 'personal', from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' }),
    ).not.toThrow()
  })

  it('rejects to <= from for both search and export filters', () => {
    expect(() => calendarSearchFilterSchema.parse({ from: '2026-08-08T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' })).toThrow()
    expect(() => calendarExportFilterSchema.parse({ from: '2026-08-08T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' })).toThrow()
  })
})

describe('feed projection discrimination', () => {
  it('an event item is editable: true and passes the discriminated union', () => {
    const item = calendarFeedItemSchema.parse({ ...VALID_EVENT, kind: 'event', editable: true })
    expect(item.kind).toBe('event')
    expect(item.editable).toBe(true)
  })

  it.each(['job_projection', 'alert_projection'] as const)('a %s projection is editable: false and estimateOnly: true', (kind) => {
    const item = calendarFeedItemSchema.parse({
      kind,
      sourceType: 'operational_schedule',
      sourceId: 'job-1',
      editable: false,
      estimateOnly: true,
      title: 'Nightly enrichment',
      startsAt: VALID_EVENT.startsAt,
      endsAt: VALID_EVENT.endsAt,
      safeSourceRoute: '/dashboard/admin/jobs/job-1',
    })
    expect(item.editable).toBe(false)
    if (item.kind === 'job_projection' || item.kind === 'alert_projection') {
      expect(item.estimateOnly).toBe(true)
    }
  })

  it('a job_run projection is editable: false and estimateOnly: false, carrying a state', () => {
    const item = calendarFeedItemSchema.parse({
      kind: 'job_run',
      sourceType: 'job_run',
      sourceId: 'run-1',
      editable: false,
      estimateOnly: false,
      state: 'succeeded',
      title: 'Nightly enrichment run',
      startsAt: VALID_EVENT.startsAt,
      endsAt: VALID_EVENT.endsAt,
      safeSourceRoute: '/dashboard/admin/jobs/run-1',
    })
    expect(item.editable).toBe(false)
  })

  it('rejects a projection item that claims editable: true (cannot masquerade as a mutable event)', () => {
    expect(() =>
      calendarFeedItemSchema.parse({
        kind: 'job_projection',
        sourceType: 'operational_schedule',
        sourceId: 'job-1',
        editable: true,
        estimateOnly: true,
        title: 'Nightly enrichment',
        startsAt: VALID_EVENT.startsAt,
        endsAt: VALID_EVENT.endsAt,
        safeSourceRoute: '/dashboard/admin/jobs/job-1',
      }),
    ).toThrow()
  })
})
