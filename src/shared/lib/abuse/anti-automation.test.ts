import { describe, expect, it, vi } from 'vitest'
import {
  checkExportBurstAndEmit,
  detectMissingOrImplausibleHeaders,
  detectNonInteractiveCadence,
  recordExportRequestCadence,
} from './anti-automation'

describe('detectMissingOrImplausibleHeaders', () => {
  it.each([
    [{ userAgent: null, accept: 'text/html' }, true], // missing UA
    [{ userAgent: 'Mozilla/5.0 (Macintosh)', accept: null }, true], // missing Accept
    [{ userAgent: 'Mozilla/5.0 (Macintosh)', accept: 'text/html' }, false], // plausible browser
    [{ userAgent: 'curl/8.4.0', accept: '*/*' }, true],
    [{ userAgent: 'python-requests/2.31.0', accept: '*/*' }, true],
    [{ userAgent: 'PostmanRuntime/7.36.0', accept: '*/*' }, true],
    [{ userAgent: 'okhttp/4.12.0', accept: '*/*' }, true],
    [{ userAgent: 'axios/1.6.0', accept: 'application/json' }, true],
    [{ userAgent: 'Scrapy/2.11.0 (+https://scrapy.org)', accept: '*/*' }, true],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', accept: 'text/html,application/json' }, false],
  ])('detectMissingOrImplausibleHeaders(%o) -> %s', (input, expected) => {
    expect(detectMissingOrImplausibleHeaders(input)).toBe(expected)
  })
})

describe('detectNonInteractiveCadence', () => {
  it('never flags the very first request (no prior timestamp)', () => {
    expect(detectNonInteractiveCadence(null, Date.now())).toBe(false)
  })

  it('flags a request under the minimum human interval', () => {
    const now = 1_000_000
    expect(detectNonInteractiveCadence(now - 100, now, 500)).toBe(true)
  })

  it('does not flag a request at or beyond the minimum human interval', () => {
    const now = 1_000_000
    expect(detectNonInteractiveCadence(now - 500, now, 500)).toBe(false)
    expect(detectNonInteractiveCadence(now - 2000, now, 500)).toBe(false)
  })

  it('respects a custom minHumanIntervalMs', () => {
    const now = 1_000_000
    expect(detectNonInteractiveCadence(now - 800, now, 1000)).toBe(true)
    expect(detectNonInteractiveCadence(now - 800, now, 100)).toBe(false)
  })
})

describe('recordExportRequestCadence', () => {
  it('does not flag the first call for a fresh key', () => {
    const key = `cadence-test-${crypto.randomUUID()}`
    expect(recordExportRequestCadence(key, 1_000_000)).toBe(false)
  })

  it('flags a second call that arrives too soon after the first, for the same key', () => {
    const key = `cadence-test-${crypto.randomUUID()}`
    expect(recordExportRequestCadence(key, 1_000_000)).toBe(false)
    expect(recordExportRequestCadence(key, 1_000_100)).toBe(true) // 100ms later, under the 500ms default
  })

  it('does not flag a second call that arrives well after the first', () => {
    const key = `cadence-test-${crypto.randomUUID()}`
    expect(recordExportRequestCadence(key, 1_000_000)).toBe(false)
    expect(recordExportRequestCadence(key, 1_005_000)).toBe(false) // 5s later
  })

  it('tracks distinct keys independently', () => {
    const keyA = `cadence-test-a-${crypto.randomUUID()}`
    const keyB = `cadence-test-b-${crypto.randomUUID()}`
    expect(recordExportRequestCadence(keyA, 1_000_000)).toBe(false)
    // keyB's first-ever call, even at the identical timestamp, has no prior entry of its own.
    expect(recordExportRequestCadence(keyB, 1_000_000)).toBe(false)
  })
})

describe('checkExportBurstAndEmit', () => {
  it('does not emit when neither heuristic fires', async () => {
    const insert = vi.fn()
    const flagged = await checkExportBurstAndEmit(
      { suspiciousHeaders: false, nonInteractiveCadence: false },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('emits export_burst when suspicious headers alone fire', async () => {
    const insert = vi.fn()
    const flagged = await checkExportBurstAndEmit(
      { suspiciousHeaders: true, nonInteractiveCadence: false },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'export_burst',
      details: expect.objectContaining({ suspiciousHeaders: true, nonInteractiveCadence: false }),
    }))
  })

  it('emits export_burst when non-interactive cadence alone fires', async () => {
    const insert = vi.fn()
    const flagged = await checkExportBurstAndEmit(
      { suspiciousHeaders: false, nonInteractiveCadence: true },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
  })
})
