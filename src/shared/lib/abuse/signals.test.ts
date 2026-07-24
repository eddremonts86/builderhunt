import { describe, expect, it, vi } from 'vitest'
import { emitAbuseSignal, hashSessionId } from './signals'

describe('hashSessionId', () => {
  it('is stable for the same session id and salt', () => {
    const a = hashSessionId('session-1', 'salt-1')
    const b = hashSessionId('session-1', 'salt-1')
    expect(a).toEqual(b)
  })

  it('differs when the session id differs', () => {
    expect(hashSessionId('session-1', 'salt-1')).not.toEqual(hashSessionId('session-2', 'salt-1'))
  })

  it('differs when the salt differs', () => {
    expect(hashSessionId('session-1', 'salt-1')).not.toEqual(hashSessionId('session-1', 'salt-2'))
  })

  it('never leaks the raw session id in the hash', () => {
    expect(hashSessionId('super-secret-session-token', 'salt-1')).not.toContain('super-secret-session-token')
  })
})

describe('emitAbuseSignal', () => {
  it('writes a redacted security-audit event and a durable abuse_signals row', async () => {
    const sink = { write: vi.fn() }
    const insert = vi.fn().mockResolvedValue(undefined)

    await emitAbuseSignal({
      type: 'concurrent_sessions',
      severity: 'medium',
      requestId: 'req-1',
      userId: 'user-1',
      organizationId: 'org-1',
      details: { email: 'a@example.com', count: 3 },
    }, { sink, insert })

    expect(sink.write).toHaveBeenCalledTimes(1)
    const auditEvent = sink.write.mock.calls[0][0]
    expect(auditEvent).toMatchObject({
      organizationId: 'org-1',
      actorUserId: 'user-1',
      action: 'abuse.concurrent_sessions',
      targetType: 'abuse_signal',
      result: 'allowed',
      requestId: 'req-1',
    })
    // redactLogValue redacts sensitive-keyed fields (e.g. "email") before they ever reach the sink.
    expect(auditEvent.details.email).toBe('[REDACTED]')
    expect(auditEvent.details.count).toBe(3)

    expect(insert).toHaveBeenCalledTimes(1)
    const inserted = insert.mock.calls[0][0]
    expect(inserted).toMatchObject({
      type: 'concurrent_sessions',
      severity: 'medium',
      userId: 'user-1',
      organizationId: 'org-1',
      requestId: 'req-1',
      details: { email: 'a@example.com', count: 3 },
    })
    expect(typeof inserted.id).toBe('string')
    expect(inserted.id.length).toBeGreaterThan(0)
  })

  it('defaults userId/organizationId to null when omitted', async () => {
    const sink = { write: vi.fn() }
    const insert = vi.fn().mockResolvedValue(undefined)

    await emitAbuseSignal({
      type: 'signup_velocity',
      severity: 'low',
      requestId: 'req-2',
    }, { sink, insert })

    expect(sink.write.mock.calls[0][0]).toMatchObject({ organizationId: null, actorUserId: null })
    expect(insert.mock.calls[0][0]).toMatchObject({ userId: null, organizationId: null, details: {} })
  })
})
