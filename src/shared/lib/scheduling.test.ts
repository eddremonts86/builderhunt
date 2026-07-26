import { describe, expect, it } from 'vitest'
import {
  assertValidInvitationStatusTransition,
  availabilityOverrideSchema,
  availabilityRuleSchema,
  computeSlotId,
  consentReceiptSchema,
  expandRecurrenceRule,
  generateAvailabilitySlots,
  hasAcceptedAllRequiredConsents,
  isValidIanaTimeZone,
  resolveLocalWallClockInstant,
  resolveRequiredConsentPurposes,
  SchedulingError,
  subtractBusyRanges,
  toSafePublicSchedulingErrorCode,
  type AvailabilityRule,
} from './scheduling'

function baseRule(overrides: Partial<AvailabilityRule> = {}): AvailabilityRule {
  return {
    ownerUserId: 'user-1',
    timeZone: 'Europe/Copenhagen',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    localStart: '09:00',
    localEnd: '17:00',
    slotMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 60,
    enabled: true,
    ...overrides,
  }
}

describe('isValidIanaTimeZone', () => {
  it.each(['Europe/Copenhagen', 'UTC', 'America/New_York', 'Asia/Kolkata'])('accepts %s', (tz) => {
    expect(isValidIanaTimeZone(tz)).toBe(true)
  })

  it.each(['Not/AZone', 'GMT+2', ''])('rejects %s', (tz) => {
    expect(isValidIanaTimeZone(tz)).toBe(false)
  })
})

describe('resolveLocalWallClockInstant', () => {
  it('resolves a UTC time uniquely', () => {
    const result = resolveLocalWallClockInstant({ timeZone: 'UTC', year: 2026, month: 6, day: 15, hour: 9, minute: 0 })
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(result.instant.toISOString()).toBe('2026-06-15T09:00:00.000Z')
  })

  it('resolves a fixed half-hour offset zone (Asia/Kolkata, UTC+5:30)', () => {
    const result = resolveLocalWallClockInstant({ timeZone: 'Asia/Kolkata', year: 2026, month: 6, day: 15, hour: 9, minute: 0 })
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(result.instant.toISOString()).toBe('2026-06-15T03:30:00.000Z')
  })

  it('resolves an ordinary America/New_York time', () => {
    const result = resolveLocalWallClockInstant({ timeZone: 'America/New_York', year: 2026, month: 6, day: 15, hour: 9, minute: 0 })
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(result.instant.toISOString()).toBe('2026-06-15T13:00:00.000Z')
  })

  it('omits a Copenhagen spring-forward gap time (2026-03-29 02:30 does not exist)', () => {
    const result = resolveLocalWallClockInstant({ timeZone: 'Europe/Copenhagen', year: 2026, month: 3, day: 29, hour: 2, minute: 30 })
    expect(result.kind).toBe('nonexistent')
  })

  it('resolves a normal time on the same spring-forward day without shifting it', () => {
    const result = resolveLocalWallClockInstant({ timeZone: 'Europe/Copenhagen', year: 2026, month: 3, day: 29, hour: 9, minute: 0 })
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(result.instant.toISOString()).toBe('2026-03-29T07:00:00.000Z')
  })

  it('labels a Copenhagen fall-back ambiguous time (2026-10-25 02:30 occurs twice) and resolves deterministically', () => {
    const result = resolveLocalWallClockInstant({ timeZone: 'Europe/Copenhagen', year: 2026, month: 10, day: 25, hour: 2, minute: 30 })
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.earlierInstant.toISOString()).toBe('2026-10-25T00:30:00.000Z')
      expect(result.laterInstant.toISOString()).toBe('2026-10-25T01:30:00.000Z')
      expect(result.instant.toISOString()).toBe(result.earlierInstant.toISOString())
    }
  })
})

describe('availabilityRuleSchema (overnight rejection)', () => {
  it('accepts a normal same-day rule', () => {
    expect(() => availabilityRuleSchema.parse(baseRule())).not.toThrow()
  })

  it('rejects an overnight rule (localEnd before localStart)', () => {
    expect(() => availabilityRuleSchema.parse(baseRule({ localStart: '22:00', localEnd: '06:00' }))).toThrow()
  })

  it('rejects localEnd equal to localStart', () => {
    expect(() => availabilityRuleSchema.parse(baseRule({ localStart: '09:00', localEnd: '09:00' }))).toThrow()
  })

  it('rejects an invalid IANA timezone', () => {
    expect(() => availabilityRuleSchema.parse(baseRule({ timeZone: 'Not/AZone' }))).toThrow()
  })
})

describe('availabilityOverrideSchema', () => {
  it('accepts a blocked override with null times', () => {
    expect(() =>
      availabilityOverrideSchema.parse({ ownerUserId: 'user-1', localDate: '2026-08-01', localStart: null, localEnd: null, kind: 'blocked', timeZone: 'UTC' }),
    ).not.toThrow()
  })

  it('rejects a blocked override with times set', () => {
    expect(() =>
      availabilityOverrideSchema.parse({ ownerUserId: 'user-1', localDate: '2026-08-01', localStart: '09:00', localEnd: '10:00', kind: 'blocked', timeZone: 'UTC' }),
    ).toThrow()
  })

  it('accepts an available override with valid times', () => {
    expect(() =>
      availabilityOverrideSchema.parse({ ownerUserId: 'user-1', localDate: '2026-08-01', localStart: '09:00', localEnd: '12:00', kind: 'available', timeZone: 'UTC' }),
    ).not.toThrow()
  })

  it('rejects an available override with null times', () => {
    expect(() =>
      availabilityOverrideSchema.parse({ ownerUserId: 'user-1', localDate: '2026-08-01', localStart: null, localEnd: null, kind: 'available', timeZone: 'UTC' }),
    ).toThrow()
  })
})

describe('computeSlotId', () => {
  it('is deterministic for the same owner/instant pair', () => {
    const start = new Date('2026-08-01T09:00:00.000Z')
    const end = new Date('2026-08-01T09:30:00.000Z')
    expect(computeSlotId('user-1', start, end)).toBe(computeSlotId('user-1', start, end))
  })

  it('differs for a different owner or instant', () => {
    const start = new Date('2026-08-01T09:00:00.000Z')
    const end = new Date('2026-08-01T09:30:00.000Z')
    expect(computeSlotId('user-1', start, end)).not.toBe(computeSlotId('user-2', start, end))
    expect(computeSlotId('user-1', start, end)).not.toBe(computeSlotId('user-1', new Date('2026-08-01T10:00:00.000Z'), end))
  })
})

describe('subtractBusyRanges (buffer collisions)', () => {
  it('removes a candidate slot that overlaps a busy range', () => {
    const candidates = [{ startsAt: new Date('2026-08-01T09:00:00Z'), endsAt: new Date('2026-08-01T09:30:00Z') }]
    const busy = [{ start: new Date('2026-08-01T09:15:00Z'), end: new Date('2026-08-01T09:45:00Z') }]
    expect(subtractBusyRanges(candidates, busy)).toEqual([])
  })

  it('keeps a candidate slot with no overlap', () => {
    const candidates = [{ startsAt: new Date('2026-08-01T09:00:00Z'), endsAt: new Date('2026-08-01T09:30:00Z') }]
    const busy = [{ start: new Date('2026-08-01T10:00:00Z'), end: new Date('2026-08-01T10:30:00Z') }]
    expect(subtractBusyRanges(candidates, busy)).toHaveLength(1)
  })
})

describe('generateAvailabilitySlots', () => {
  it('generates deterministically ordered slots within a simple one-day window', () => {
    const rule = availabilityRuleSchema.parse(baseRule({ localStart: '09:00', localEnd: '10:00', slotMinutes: 30 }))
    const slots = generateAvailabilitySlots({
      ownerUserId: 'user-1',
      rule,
      overrides: [],
      busyRanges: [],
      rangeFrom: new Date('2026-08-03T00:00:00Z'),
      rangeTo: new Date('2026-08-04T00:00:00Z'),
      now: new Date('2026-08-01T00:00:00Z'),
    })
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual(['2026-08-03T07:00:00.000Z', '2026-08-03T07:30:00.000Z'])
    // deterministic ordering: re-running produces the exact same order
    const again = generateAvailabilitySlots({
      ownerUserId: 'user-1',
      rule,
      overrides: [],
      busyRanges: [],
      rangeFrom: new Date('2026-08-03T00:00:00Z'),
      rangeTo: new Date('2026-08-04T00:00:00Z'),
      now: new Date('2026-08-01T00:00:00Z'),
    })
    expect(again).toEqual(slots)
  })

  it('returns no availability when the only matching weekday is blocked by an override', () => {
    const ruleWithMonday = availabilityRuleSchema.parse(baseRule({ weekdays: [1] }))
    const slots = generateAvailabilitySlots({
      ownerUserId: 'user-1',
      rule: ruleWithMonday,
      overrides: [
        { ownerUserId: 'user-1', localDate: '2026-08-03', localStart: null, localEnd: null, kind: 'blocked', timeZone: 'Europe/Copenhagen' },
      ],
      busyRanges: [],
      rangeFrom: new Date('2026-08-03T00:00:00Z'),
      rangeTo: new Date('2026-08-04T00:00:00Z'),
      now: new Date('2026-08-01T00:00:00Z'),
    })
    expect(slots).toEqual([])
  })

  it('applies buffers to make an otherwise-free slot unavailable (buffer collision)', () => {
    const rule = availabilityRuleSchema.parse(baseRule({ localStart: '09:00', localEnd: '10:00', slotMinutes: 30, bufferBeforeMinutes: 30, bufferAfterMinutes: 30 }))
    const slots = generateAvailabilitySlots({
      ownerUserId: 'user-1',
      rule,
      overrides: [],
      // A confirmed meeting at 08:15-08:45 CEST (06:15-06:45 UTC); with a 30-min buffer on each
      // side the buffered range becomes 05:45-07:15 UTC, which overlaps the 07:00-07:30 UTC
      // (09:00-09:30 CEST) slot even though the meeting itself does not.
      busyRanges: [{ start: new Date('2026-08-03T06:15:00Z'), end: new Date('2026-08-03T06:45:00Z') }],
      rangeFrom: new Date('2026-08-03T00:00:00Z'),
      rangeTo: new Date('2026-08-04T00:00:00Z'),
      now: new Date('2026-08-01T00:00:00Z'),
    })
    expect(slots.some((s) => s.startsAt.toISOString() === '2026-08-03T07:00:00.000Z')).toBe(false)
  })

  it('respects minimum notice and booking horizon', () => {
    const rule = availabilityRuleSchema.parse(baseRule({ minNoticeMinutes: 24 * 60, horizonDays: 2 }))
    const slots = generateAvailabilitySlots({
      ownerUserId: 'user-1',
      rule,
      overrides: [],
      busyRanges: [],
      rangeFrom: new Date('2026-08-01T00:00:00Z'),
      rangeTo: new Date('2026-08-10T00:00:00Z'),
      now: new Date('2026-08-01T00:00:00Z'),
    })
    for (const slot of slots) {
      expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(new Date('2026-08-02T00:00:00Z').getTime())
      expect(slot.startsAt.getTime()).toBeLessThan(new Date('2026-08-03T00:00:00Z').getTime())
    }
  })
})

describe('expandRecurrenceRule (recurrence exclusions)', () => {
  it('expands a weekly rule and excludes a listed exception instant', () => {
    const occurrences = expandRecurrenceRule({
      rruleText: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5',
      eventStartsAt: new Date('2026-03-02T09:00:00Z'),
      eventDurationMs: 30 * 60_000,
      timeZone: 'UTC',
      rangeFrom: new Date('2026-01-01T00:00:00Z'),
      rangeTo: new Date('2027-01-01T00:00:00Z'),
      exceptionInstants: [new Date('2026-03-16T09:00:00Z')],
    })
    expect(occurrences).toHaveLength(4)
    expect(occurrences.some((o) => o.startsAt.toISOString() === '2026-03-16T09:00:00.000Z')).toBe(false)
  })

  it('preserves local wall-clock time across a DST transition (Copenhagen)', () => {
    const occurrences = expandRecurrenceRule({
      rruleText: 'FREQ=WEEKLY;BYDAY=MO;COUNT=6',
      eventStartsAt: new Date('2026-03-16T08:00:00Z'), // 09:00 CET
      eventDurationMs: 30 * 60_000,
      timeZone: 'Europe/Copenhagen',
      rangeFrom: new Date('2026-01-01T00:00:00Z'),
      rangeTo: new Date('2027-01-01T00:00:00Z'),
      exceptionInstants: [],
    })
    const beforeDst = occurrences.find((o) => o.startsAt.toISOString() === '2026-03-16T08:00:00.000Z')
    const afterDst = occurrences.find((o) => o.startsAt.toISOString().startsWith('2026-03-30'))
    expect(beforeDst).toBeDefined()
    // After the spring-forward transition, 09:00 local is 07:00 UTC (CEST, UTC+2) — the wall
    // clock time stays 09:00, the UTC instant shifts.
    expect(afterDst?.startsAt.toISOString()).toBe('2026-03-30T07:00:00.000Z')
  })

  it('produces occurrences in deterministic chronological order', () => {
    const occurrences = expandRecurrenceRule({
      rruleText: 'FREQ=DAILY;COUNT=5',
      eventStartsAt: new Date('2026-08-01T09:00:00Z'),
      eventDurationMs: 60 * 60_000,
      timeZone: 'UTC',
      rangeFrom: new Date('2026-01-01T00:00:00Z'),
      rangeTo: new Date('2027-01-01T00:00:00Z'),
      exceptionInstants: [],
    })
    const sorted = [...occurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    expect(occurrences).toEqual(sorted)
  })

  it('rejects an unsupported recurrence rule rather than approximating it', () => {
    expect(() =>
      expandRecurrenceRule({
        rruleText: 'FREQ=SECONDLY',
        eventStartsAt: new Date('2026-08-01T09:00:00Z'),
        eventDurationMs: 60 * 60_000,
        timeZone: 'UTC',
        rangeFrom: new Date('2026-01-01T00:00:00Z'),
        rangeTo: new Date('2027-01-01T00:00:00Z'),
        exceptionInstants: [],
      }),
    ).toThrow()
  })
})

describe('invitation status transitions', () => {
  it('allows the full draft -> sent -> opened -> booked path', () => {
    expect(() => assertValidInvitationStatusTransition('draft', 'sent')).not.toThrow()
    expect(() => assertValidInvitationStatusTransition('sent', 'opened')).not.toThrow()
    expect(() => assertValidInvitationStatusTransition('opened', 'booked')).not.toThrow()
  })

  it.each(['booked', 'declined', 'expired', 'revoked'] as const)('rejects every transition out of the terminal state %s', (terminal) => {
    for (const to of ['draft', 'sent', 'opened', 'booked', 'declined', 'expired', 'revoked'] as const) {
      expect(() => assertValidInvitationStatusTransition(terminal, to)).toThrow(SchedulingError)
    }
  })

  it('rejects skipping straight from draft to booked', () => {
    expect(() => assertValidInvitationStatusTransition('draft', 'booked')).toThrow()
  })
})

describe('consent receipts', () => {
  it('parses a valid consent receipt', () => {
    expect(() =>
      consentReceiptSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        invitationId: '22222222-2222-4222-8222-222222222222',
        sessionId: null,
        subjectEmailHash: 'hash-abc',
        purpose: 'terms_and_privacy',
        noticeVersion: 'v1',
        decision: 'accepted',
        decidedAt: '2026-08-01T09:00:00.000Z',
        withdrawnAt: null,
        requestEvidenceHash: 'evidence-abc',
        supersedesId: null,
      }),
    ).not.toThrow()
  })

  it('resolveRequiredConsentPurposes always requires terms_and_privacy and only the invoked feature purposes', () => {
    expect(resolveRequiredConsentPurposes({ includesDocumentUpload: false, includesWebImport: false, includesAiAssistance: false, includesLiveTranscription: false })).toEqual([
      'terms_and_privacy',
    ])
    expect(
      resolveRequiredConsentPurposes({ includesDocumentUpload: true, includesWebImport: false, includesAiAssistance: true, includesLiveTranscription: false }),
    ).toEqual(['terms_and_privacy', 'candidate_document_processing', 'ai_interview_assistance'])
  })

  it('hasAcceptedAllRequiredConsents requires every required purpose to be accepted, not merely decided', () => {
    const required = resolveRequiredConsentPurposes({ includesDocumentUpload: true, includesWebImport: false, includesAiAssistance: false, includesLiveTranscription: false })
    expect(
      hasAcceptedAllRequiredConsents(
        [{ purpose: 'terms_and_privacy', decision: 'accepted' }, { purpose: 'candidate_document_processing', decision: 'declined' }],
        required,
      ),
    ).toBe(false)
    expect(
      hasAcceptedAllRequiredConsents(
        [{ purpose: 'terms_and_privacy', decision: 'accepted' }, { purpose: 'candidate_document_processing', decision: 'accepted' }],
        required,
      ),
    ).toBe(true)
  })
})

describe('toSafePublicSchedulingErrorCode', () => {
  it('passes through an allowlisted public code', () => {
    expect(toSafePublicSchedulingErrorCode('slot_unavailable')).toBe('slot_unavailable')
  })

  it('maps any internal/unknown code to invalid_input rather than leaking it', () => {
    expect(toSafePublicSchedulingErrorCode('organization_mismatch')).toBe('invalid_input')
    expect(toSafePublicSchedulingErrorCode('internal_conflict_with_org_abc123')).toBe('invalid_input')
  })
})
