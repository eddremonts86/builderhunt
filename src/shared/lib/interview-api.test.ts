import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES, API_ERROR_HTTP_STATUS, httpStatusForApiErrorCode } from './api-errors'
import {
  bookSlotRequestSchema,
  calendarFeedRequestSchema,
  createEventRequestSchema,
  createInvitationRequestSchema,
  findForbiddenAuthorityFields,
  INTERVIEW_API_ROUTES,
  markNotificationsReadRequestSchema,
  putAvailabilityRequestSchema,
  submitSegmentsRequestSchema,
} from './interview-api'

describe('INTERVIEW_API_ROUTES registry', () => {
  it('every route row has a unique method+path pair', () => {
    const seen = new Set<string>()
    for (const route of INTERVIEW_API_ROUTES) {
      const key = `${route.method} ${route.path}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('every route declares a valid authority', () => {
    const validAuthorities = new Set(['user', 'owner', 'participant', 'capability', 'fragment_capability', 'role_minimized'])
    for (const route of INTERVIEW_API_ROUTES) {
      expect(validAuthorities.has(route.authority)).toBe(true)
    }
  })
})

describe('request schemas reject unknown fields (.strict())', () => {
  it.each(
    INTERVIEW_API_ROUTES.filter((r) => r.requestSchema !== null).map((r) => [r.method, r.path, r.requestSchema] as const),
  )('%s %s rejects an unexpected extra field', (_method, _path, schema) => {
    const emptyAttempt = schema!.safeParse({ definitelyNotARealField: true })
    expect(emptyAttempt.success).toBe(false)
  })
})

describe('bounded ranges and batches', () => {
  it('calendarFeedRequestSchema rejects to <= from', () => {
    const result = calendarFeedRequestSchema.safeParse({
      from: '2026-08-08T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      timezone: 'UTC',
      layers: ['events'],
    })
    expect(result.success).toBe(false)
  })

  it('calendarFeedRequestSchema rejects an oversized layers array', () => {
    const result = calendarFeedRequestSchema.safeParse({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-08T00:00:00.000Z',
      timezone: 'UTC',
      layers: Array(11).fill('events'),
    })
    expect(result.success).toBe(false)
  })

  it('markNotificationsReadRequestSchema rejects an oversized deliveryIds batch', () => {
    const ids = Array.from({ length: 101 }, () => '11111111-1111-4111-8111-111111111111')
    expect(markNotificationsReadRequestSchema.safeParse({ deliveryIds: ids }).success).toBe(false)
  })

  it('markNotificationsReadRequestSchema rejects an empty batch', () => {
    expect(markNotificationsReadRequestSchema.safeParse({ deliveryIds: [] }).success).toBe(false)
  })

  it('submitSegmentsRequestSchema rejects an oversized segment batch', () => {
    const segments = Array.from({ length: 51 }, (_, i) => ({
      providerSegmentId: `seg-${i}`,
      sequence: i,
      speakerEstimate: 'speaker_a',
      text: 'hello',
      startsMs: 0,
      endsMs: 1000,
      confidence: null,
    }))
    expect(submitSegmentsRequestSchema.safeParse({ segments, idempotencyKey: 'key-1' }).success).toBe(false)
  })

  it('putAvailabilityRequestSchema rejects an oversized rules array', () => {
    const rules = Array.from({ length: 21 }, () => ({
      timeZone: 'UTC',
      weekdays: [1],
      localStart: '09:00',
      localEnd: '17:00',
      slotMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      horizonDays: 30,
      enabled: true,
    }))
    expect(
      putAvailabilityRequestSchema.safeParse({
        version: 1,
        rules,
        overrides: [],
        defaultReminderOffsets: [],
        defaultReminderChannels: [],
      }).success,
    ).toBe(false)
  })

  it('bookSlotRequestSchema requires at least one consent receipt ID', () => {
    expect(
      bookSlotRequestSchema.safeParse({
        slotId: 'slot-1',
        submissionVersion: 1,
        consentReceiptIds: [],
        idempotencyKey: 'key-1',
      }).success,
    ).toBe(false)
  })
})

describe('common error codes have a stable HTTP mapping', () => {
  it.each(API_ERROR_CODES.map((code) => [code] as const))('%s maps to a fixed status', (code) => {
    const status = httpStatusForApiErrorCode(code)
    expect(status).toBe(API_ERROR_HTTP_STATUS[code])
    expect([400, 401, 403, 404, 409, 413, 415, 422, 429, 503]).toContain(status)
  })

  it('every declared spec.md common error code is represented', () => {
    const specCommonCodes = [
      'invalid_input', 'authentication_required', 'forbidden', 'not_found',
      'state_changed', 'slot_unavailable', 'insufficient_credits', 'too_large',
      'unsupported_media_type', 'consent_required', 'source_not_importable',
      'rate_limited', 'dependency_unavailable',
    ]
    for (const code of specCommonCodes) {
      expect(API_ERROR_CODES).toContain(code)
    }
  })

  it('invitation_unavailable and not_found share 404 (non-enumerating public capability errors)', () => {
    expect(httpStatusForApiErrorCode('invitation_unavailable')).toBe(httpStatusForApiErrorCode('not_found'))
  })
})

describe('no server-authority fields in client request schemas', () => {
  it.each(
    INTERVIEW_API_ROUTES.filter((r) => r.requestSchema !== null).map((r) => [r.method, r.path, r.requestSchema] as const),
  )('%s %s never accepts organizationId/ownerUserId/provider/price/credit fields', (_method, _path, schema) => {
    expect(findForbiddenAuthorityFields(schema!)).toEqual([])
  })
})

describe('valid fixtures instantiate cleanly', () => {
  it('createEventRequestSchema accepts a minimal valid draft', () => {
    const result = createEventRequestSchema.safeParse({
      type: 'personal',
      title: 'Standup',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T09:30:00.000Z',
      timezone: 'Europe/Copenhagen',
      allDay: false,
      busy: true,
      reminders: [],
      participants: [],
    })
    expect(result.success).toBe(true)
  })

  it('createInvitationRequestSchema accepts a minimal valid draft', () => {
    const result = createInvitationRequestSchema.safeParse({
      candidateEmail: 'candidate@example.com',
      roleTitle: 'Senior Engineer',
      roleContext: 'Backend team, distributed systems focus.',
      durationMinutes: 60,
      timezone: 'Europe/Copenhagen',
      modality: 'remote_call',
    })
    expect(result.success).toBe(true)
  })
})

describe('no private ORM/provider object is assignable to a public DTO', () => {
  it('a raw Drizzle-row-shaped object (with server-only columns) fails every response schema meant to be client-facing', () => {
    // Simulates a raw DB row leaking straight into a route handler's response — it must never
    // satisfy a public response schema, because a real row carries organization_id/internal
    // timestamps/etc. that the DTO schemas below deliberately don't declare.
    const fakeOrmRow = {
      id: '11111111-1111-4111-8111-111111111111',
      organization_id: 'org-abc',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      __raw_provider_response: { some: 'vendor', payload: true },
    }

    for (const route of INTERVIEW_API_ROUTES) {
      if (!route.responseSchema) continue
      const result = route.responseSchema.safeParse(fakeOrmRow)
      expect(result.success).toBe(false)
    }
  })
})
