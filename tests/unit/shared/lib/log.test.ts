import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log, logged } from '~/shared/lib/log'

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
