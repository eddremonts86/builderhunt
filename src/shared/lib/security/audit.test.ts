import { describe, expect, it, vi } from 'vitest'
import { emitSecurityAudit } from './audit'

describe('security audit events', () => {
  it('writes allowlisted correlation fields with redacted details', async () => {
    const write = vi.fn()
    await emitSecurityAudit({
      organizationId: 'org-a',
      actorUserId: 'user-a',
      action: 'organization.invite',
      targetType: 'invitation',
      targetId: 'invite-a',
      result: 'denied',
      requestId: 'request-a',
      details: { email: 'person@example.test', token: 'token-canary', reason: 'seat-limit' },
    }, { write })

    const event = write.mock.calls[0][0]
    expect(event).toMatchObject({ organizationId: 'org-a', action: 'organization.invite', result: 'denied' })
    expect(JSON.stringify(event)).not.toContain('person@example.test')
    expect(JSON.stringify(event)).not.toContain('token-canary')
    expect(event.details.reason).toBe('seat-limit')
  })
})
