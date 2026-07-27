import { describe, expect, it, vi } from 'vitest'

// Same pattern as solutions/config.test.ts: env.ts always uses its browser-stub branch under
// vitest's happy-dom environment, so vi.stubEnv alone can never change what env.CALENDAR_ENABLED
// etc. resolve to in a test. Mocking the env module directly is the only reliable way.
const mockEnv = vi.hoisted(() => ({
  CALENDAR_ENABLED: 'false' as 'true' | 'false',
  SCHEDULING_ENABLED: 'false' as 'true' | 'false',
  CANDIDATE_UPLOADS_ENABLED: 'false' as 'true' | 'false',
  CANDIDATE_WEB_IMPORT_ENABLED: 'false' as 'true' | 'false',
  SENSITIVE_AI_ENABLED: 'false' as 'true' | 'false',
  INTERVIEW_TRANSCRIPTION_ENABLED: 'false' as 'true' | 'false',
  INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED: 'false' as 'true' | 'false',
  CALENDAR_OPERATIONAL_LAYERS_ENABLED: 'false' as 'true' | 'false',
}))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const {
  INTERVIEW_DOCUMENT_MIME_TYPES,
  isSupportedDocumentMimeType,
  INTERVIEW_DOCUMENT_MAX_BYTES_PER_FILE,
  INTERVIEW_DOCUMENT_MAX_BYTES_TOTAL,
  CANDIDATE_WEB_IMPORT_MAX_BYTES,
  assertPositiveByteLimit,
  INTERVIEW_RETENTION_DEFAULTS,
  resolveRetentionDays,
  CHROME_CURRENT_SUPPORTED_MAJOR,
  isSupportedChromeMajor,
  INTERVIEW_CAPTURE_MODES,
  INTERVIEW_SUPPORTED_LANGUAGES,
  isSupportedInterviewLanguage,
  AVAILABILITY_HORIZON_DEFAULT_DAYS,
  AVAILABILITY_HORIZON_MAX_DAYS,
  assertValidHorizonDays,
  INTERVIEW_RATE_CARD_KEYS,
  getInterviewRateCardKey,
  INTERVIEW_TYPICAL_60_MINUTE_ESTIMATE_UNITS,
  LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_FRACTIONS,
  LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_MINUTES_REMAINING,
  INTERVIEW_ENTITLEMENT_TIERS,
  getInterviewFeatureFlags,
} = await import('~/shared/lib/interview-config')

describe('document upload contract', () => {
  it('supports exactly PDF, DOCX, and TXT', () => {
    expect(Object.keys(INTERVIEW_DOCUMENT_MIME_TYPES)).toEqual([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ])
  })

  it('isSupportedDocumentMimeType rejects an unsupported type', () => {
    expect(isSupportedDocumentMimeType('application/pdf')).toBe(true)
    expect(isSupportedDocumentMimeType('image/png')).toBe(false)
  })

  it('pins the exact per-file (10 MB) and total (25 MB) limits from spec.md', () => {
    expect(INTERVIEW_DOCUMENT_MAX_BYTES_PER_FILE).toBe(10 * 1024 * 1024)
    expect(INTERVIEW_DOCUMENT_MAX_BYTES_TOTAL).toBe(25 * 1024 * 1024)
  })

  it('pins the 2 MB web-import limit', () => {
    expect(CANDIDATE_WEB_IMPORT_MAX_BYTES).toBe(2 * 1024 * 1024)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('assertPositiveByteLimit rejects %p', (bytes) => {
    expect(() => assertPositiveByteLimit(bytes, 'test limit')).toThrow()
  })

  it('assertPositiveByteLimit accepts a positive finite limit', () => {
    expect(assertPositiveByteLimit(1024, 'test limit')).toBe(1024)
  })
})

describe('retention defaults', () => {
  it('pins the exact defaults from spec.md', () => {
    expect(INTERVIEW_RETENTION_DEFAULTS).toEqual({
      transcriptSegmentDays: 90,
      documentAndReportDays: 180,
      consentAuditMonths: 24,
    })
  })

  it('falls back to the default when no organization override is requested (missing fallback)', () => {
    expect(resolveRetentionDays({ defaultDays: 90, ceilingDays: 90 })).toBe(90)
  })

  it('accepts a shorter organization-selected override', () => {
    expect(resolveRetentionDays({ requestedDays: 30, defaultDays: 90, ceilingDays: 90 })).toBe(30)
  })

  it.each([0, -5])('rejects a non-positive override of %p', (requestedDays) => {
    expect(() => resolveRetentionDays({ requestedDays, defaultDays: 90, ceilingDays: 90 })).toThrow()
  })

  it('rejects an override that exceeds the operator ceiling (excessive retention)', () => {
    expect(() => resolveRetentionDays({ requestedDays: 120, defaultDays: 90, ceilingDays: 90 })).toThrow()
  })
})

describe('Chrome desktop support matrix', () => {
  it('supports exactly the current and previous major', () => {
    expect(isSupportedChromeMajor(CHROME_CURRENT_SUPPORTED_MAJOR)).toBe(true)
    expect(isSupportedChromeMajor(CHROME_CURRENT_SUPPORTED_MAJOR - 1)).toBe(true)
  })

  it('rejects two majors behind and any future major', () => {
    expect(isSupportedChromeMajor(CHROME_CURRENT_SUPPORTED_MAJOR - 2)).toBe(false)
    expect(isSupportedChromeMajor(CHROME_CURRENT_SUPPORTED_MAJOR + 1)).toBe(false)
  })
})

describe('capture modes and languages', () => {
  it('defines exactly in_person and remote_call — manual-only is a fallback state, not a mode', () => {
    expect(INTERVIEW_CAPTURE_MODES).toEqual(['in_person', 'remote_call'])
  })

  it('supports English and Danish', () => {
    expect(INTERVIEW_SUPPORTED_LANGUAGES).toEqual(['en', 'da'])
    expect(isSupportedInterviewLanguage('en')).toBe(true)
    expect(isSupportedInterviewLanguage('da')).toBe(true)
    expect(isSupportedInterviewLanguage('fr')).toBe(false)
  })
})

describe('availability booking horizon', () => {
  it('accepts the default and rejects zero/negative/excessive values', () => {
    expect(assertValidHorizonDays(AVAILABILITY_HORIZON_DEFAULT_DAYS)).toBe(AVAILABILITY_HORIZON_DEFAULT_DAYS)
    expect(() => assertValidHorizonDays(0)).toThrow()
    expect(() => assertValidHorizonDays(-1)).toThrow()
    expect(() => assertValidHorizonDays(AVAILABILITY_HORIZON_MAX_DAYS + 1)).toThrow()
  })
})

describe('interview rate-card keys', () => {
  it('pins the exact fixed units from spec.md', () => {
    expect(INTERVIEW_RATE_CARD_KEYS.brief).toEqual({ operationKey: 'interview.brief.v1', version: 1, units: 5 })
    expect(INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute).toEqual({ operationKey: 'interview.transcription_minute.v1', version: 1, units: 1 })
    expect(INTERVIEW_RATE_CARD_KEYS.report).toEqual({ operationKey: 'interview.report.v1', version: 1, units: 5 })
  })

  it('getInterviewRateCardKey resolves a known operation', () => {
    expect(getInterviewRateCardKey('brief')).toEqual(INTERVIEW_RATE_CARD_KEYS.brief)
  })

  it('getInterviewRateCardKey throws on an unknown operation (never silently mispricing)', () => {
    expect(() => getInterviewRateCardKey('not_a_real_operation')).toThrow()
  })

  it('the typical 60-minute interview totals 70 credits per spec.md', () => {
    expect(INTERVIEW_TYPICAL_60_MINUTE_ESTIMATE_UNITS).toBe(70)
  })
})

describe('low-balance warning thresholds', () => {
  it('warns at 80% and 90%, and ten remaining minutes, per spec.md', () => {
    expect(LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_FRACTIONS).toEqual([0.8, 0.9])
    expect(LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_MINUTES_REMAINING).toBe(10)
  })
})

describe('entitlement tiers', () => {
  it('excludes free — pro/pro_max/team only', () => {
    expect(INTERVIEW_ENTITLEMENT_TIERS).toEqual(['pro', 'pro_max', 'team'])
  })
})

describe('getInterviewFeatureFlags', () => {
  it('defaults every flag to false', () => {
    expect(getInterviewFeatureFlags()).toEqual({
      calendarEnabled: false,
      schedulingEnabled: false,
      candidateUploadsEnabled: false,
      candidateWebImportEnabled: false,
      sensitiveAiEnabled: false,
      transcriptionEnabled: false,
      contextualQuestionsEnabled: false,
      operationalLayersEnabled: false,
    })
  })

  it('each flag turns on independently without affecting the others', () => {
    mockEnv.SENSITIVE_AI_ENABLED = 'true'
    try {
      const flags = getInterviewFeatureFlags()
      expect(flags.sensitiveAiEnabled).toBe(true)
      expect(flags.calendarEnabled).toBe(false)
      expect(flags.transcriptionEnabled).toBe(false)
    } finally {
      mockEnv.SENSITIVE_AI_ENABLED = 'false'
    }
  })
})
