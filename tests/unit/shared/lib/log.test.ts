import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log, logged, redactLogValue } from '~/shared/lib/log'

describe('log', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('emits info as JSON with ts + level + event', () => {
    log.info('test_event', { foo: 'bar' })
    expect(consoleLogSpy).toHaveBeenCalledTimes(1)
    const line = consoleLogSpy.mock.calls[0][0] as string
    const parsed = JSON.parse(line)
    expect(parsed.level).toBe('info')
    expect(parsed.event).toBe('test_event')
    expect(parsed.foo).toBe('bar')
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('emits warn to console.warn', () => {
    log.warn('warn_event')
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it('emits error to console.error and includes stack', () => {
    const err = new Error('boom')
    log.error('error_event', { error: err })
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const line = consoleErrorSpy.mock.calls[0][0] as string
    const parsed = JSON.parse(line)
    expect(parsed.error).toBe('boom')
    expect(parsed.stack).toBeDefined()
  })

  it('handles non-Error error values', () => {
    log.error('error_event', { error: 'just a string' })
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
    expect(parsed.error).toBe('just a string')
  })

  it('logged() wraps async function and logs duration', async () => {
    const result = await logged('op', { kind: 'test' }, async () => {
      // 25ms with a 15ms assertion floor tolerates CI clock-tick rounding
      // (Date.now() resolution can undercount a 5ms setTimeout by ~1ms on busy runners).
      await new Promise((r) => setTimeout(r, 25))
      return 42
    })
    expect(result).toBe(42)
    expect(consoleLogSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
    expect(parsed.event).toBe('op')
    expect(parsed.kind).toBe('test')
    expect(parsed.ok).toBe(true)
    expect(parsed.durationMs).toBeGreaterThanOrEqual(15)
  })

  it('logged() returns null and logs error on throw', async () => {
    const result = await logged('fail_op', {}, async () => {
      throw new Error('nope')
    })
    expect(result).toBeNull()
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('redacts nested secrets, credentials, emails, prompts, and export payloads', () => {
    log.error('canary', {
      email: 'person@example.test',
      authorization: 'Bearer token-canary',
      databaseUrl: 'postgresql://user:password-canary@db:5432/app',
      nested: { prompt: 'prompt-canary', exportPayload: { private: 'export-canary' } },
      error: new Error('failed with token=reset-canary for person@example.test'),
    })
    const line = consoleErrorSpy.mock.calls[0][0] as string
    for (const canary of ['person@example.test', 'token-canary', 'password-canary', 'prompt-canary', 'export-canary', 'reset-canary']) {
      expect(line).not.toContain(canary)
    }
  })

  it('redacts enrichment-specific fields (plan: stealth-scraping spec §15)', () => {
    log.info('enrichment_connector_result', {
      profileUrl: 'https://github.com/canary-user',
      sourceUrl: 'https://github.com/canary-user',
      submittedUrls: ['https://linkedin.com/in/canary-user'],
      payload: { bio: 'canary bio text', displayName: 'Canary Person' },
      matchSignals: ['exact_username'],
    })
    const line = consoleLogSpy.mock.calls[0][0] as string
    for (const canary of ['canary-user', 'canary bio text', 'Canary Person']) {
      expect(line).not.toContain(canary)
    }
    // Non-PII operational data (which signals matched) stays visible for debugging.
    expect(line).toContain('exact_username')
  })
})

// ── Interview material must never reach a log (plan: Phase 11) ────────────────────────────────────
//
// A log aggregator has its own retention, its own access list, and its own export. A transcript line that
// leaks into one has escaped every guarantee the interview feature makes — including the retention sweep that
// deleted it from the table. So these are assertions about the *whole serialized entry*, not about a field.

describe('interview material is redacted from every log entry', () => {
  const CANDIDATE_WORDS = 'I rewrote the cache layer in Rust and halved tail latency'

  /** The serialized entry, exactly as it would be written. */
  const entryFor = (context: Record<string, unknown>) => JSON.stringify(redactLogValue(context))

  const fields: Array<[string, Record<string, unknown>]> = [
    ['a transcript segment', { text: CANDIDATE_WORDS }],
    ['a nested transcript', { segment: { text: CANDIDATE_WORDS } }],
    ['an extracted CV', { plainText: CANDIDATE_WORDS }],
    ['snake-case extracted text', { extracted_text: CANDIDATE_WORDS }],
    ['a brief summary', { candidateSummary: CANDIDATE_WORDS }],
    ['a report statement', { statement: CANDIDATE_WORDS }],
    ['a suggestion rationale', { rationale: CANDIDATE_WORDS }],
    ['a topic answer', { answer: CANDIDATE_WORDS }],
    ['organizer notes', { organizerNotes: CANDIDATE_WORDS }],
    ['a role context', { roleContext: CANDIDATE_WORDS }],
    ['report content', { content: { summary: [{ statement: CANDIDATE_WORDS }] } }],
    ['an object key', { objectKey: 'clean/org-1/9f2c-secret' }],
    ['a signed download URL', { signedUrl: 'https://r2.example/clean/x?X-Amz-Signature=abc' }],
    ['a capability secret', { capability: 'nX9fQ2LmT7' }],
    ['a capability hash', { capabilityHash: 'a'.repeat(64) }],
    ['a provider access token', { accessToken: 'dg-grant-abc123' }],
    ['a candidate email', { candidateEmail: 'casey@candidate.invalid' }],
    ['a normalized email', { emailNormalized: 'casey@candidate.invalid' }],
    ['a document filename', { originalName: 'casey-cv.pdf' }],
    ['a prompt', { prompt: `Here is the CV: ${CANDIDATE_WORDS}` }],
    ['a provider API key', { apiKey: 'sk-live-abcdefghijklmnop' }],
  ]

  it.each(fields)('redacts %s', (_label, context) => {
    const serialized = entryFor(context)
    expect(serialized).toContain('[REDACTED')
    expect(serialized).not.toContain(CANDIDATE_WORDS)
    expect(serialized).not.toContain('9f2c-secret')
    expect(serialized).not.toContain('casey@candidate.invalid')
    expect(serialized).not.toContain('casey-cv.pdf')
    expect(serialized).not.toContain('nX9fQ2LmT7')
    expect(serialized).not.toContain('dg-grant-abc123')
    expect(serialized).not.toContain('abcdefghijklmnop')
  })

  it('redacts a capability that arrives in a URL fragment', () => {
    // The credential patterns miss this: no `token=`, no `Bearer`, just `#<secret>`. It is the entire
    // authorization for the candidate portal.
    const serialized = entryFor({
      note: 'opened https://app.test/schedule/11111111-1111-4111-8111-111111111111#nX9fQ2LmT7abcdef',
    })
    expect(serialized).not.toContain('nX9fQ2LmT7abcdef')
    expect(serialized).toContain('[REDACTED]')
  })

  it('redacts a presigned URL’s whole query string', () => {
    // `X-Amz-Signature` is only the last of several parts that together make the URL usable, so removing one
    // would leave a URL that still works.
    const serialized = entryFor({
      note: 'GET https://r2.example/clean/org/doc?X-Amz-Credential=AKIA&X-Amz-Signature=deadbeef',
    })
    expect(serialized).not.toContain('deadbeef')
    expect(serialized).not.toContain('AKIA')
  })

  it('redacts a Stripe secret key from a provider error body', () => {
    const serialized = entryFor({ note: 'Stripe rejected sk_live_51Abc123XyZ' })
    expect(serialized).not.toContain('sk_live_51Abc123XyZ')
    expect(serialized).toContain('[REDACTED_STRIPE_KEY]')
  })

  it('still logs the identifiers an operator needs', () => {
    // The point of redaction is that the log stays useful. An entry with nothing left in it would drive
    // someone to log the content directly.
    const serialized = entryFor({
      organizationId: 'org-1',
      eventId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      segmentCount: 214,
      providerBilledSeconds: 1_800,
      outcome: 'template',
    })
    expect(serialized).toContain('org-1')
    expect(serialized).toContain('11111111-1111-4111-8111-111111111111')
    expect(serialized).toContain('214')
    expect(serialized).toContain('template')
  })

  it('survives a circular structure without losing redaction', () => {
    const context: Record<string, unknown> = { text: CANDIDATE_WORDS }
    context.self = context
    const serialized = entryFor(context)
    expect(serialized).not.toContain(CANDIDATE_WORDS)
    expect(serialized).toContain('[CIRCULAR]')
  })
})

describe('the interview counters', () => {
  it('reset clears every counter, including ones added later', async () => {
    const { metrics } = await import('~/shared/lib/metrics')
    metrics.increment('interviewTemplateFallbacks', 3)
    metrics.increment('interviewRetentionRowsDeleted', 12)
    metrics.reset()
    const snapshot = metrics.get()
    // `reset` used to list every key by hand, so a counter added later survived every reset and made a test
    // that resets between cases read a previous case's number.
    expect(snapshot.interviewTemplateFallbacks).toBe(0)
    expect(snapshot.interviewRetentionRowsDeleted).toBe(0)
  })

  it('counts without carrying content', async () => {
    const { metrics } = await import('~/shared/lib/metrics')
    metrics.reset()
    metrics.increment('interviewSegmentsPersisted', 214)
    metrics.increment('interviewProhibitedOutputRefusals')
    const snapshot = metrics.get()
    expect(snapshot.interviewSegmentsPersisted).toBe(214)
    expect(snapshot.interviewProhibitedOutputRefusals).toBe(1)
    // Every *value* is a number. A regex over the serialized snapshot matched the counter *names* —
    // `interviewRetentionObjectsDeleted` is twenty-odd letters — so it was measuring my own key naming rather
    // than the absence of content.
    for (const [key, value] of Object.entries(snapshot)) {
      expect(typeof value, `${key} is not a number`).toBe('number')
    }
  })
})
