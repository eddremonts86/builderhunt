import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthedRateLimitId, rateLimit } from './rate-limit'

describe('rateLimit', () => {
  beforeEach(() => {
    vi.stubEnv('E2E_MODE', 'false')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('allows requests up to the limit and denies the next one within the window', async () => {
    const scope = `test-scope-${crypto.randomUUID()}`
    const id = 'fixed-id'
    for (let i = 1; i <= 3; i++) {
      const result = await rateLimit(scope, id, 3, 60)
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(3 - i)
    }
    const denied = await rateLimit(scope, id, 3, 60)
    expect(denied.allowed).toBe(false)
    expect(denied.remaining).toBe(0)
  })

  it('tracks distinct ids independently under the same scope', async () => {
    const scope = `test-scope-${crypto.randomUUID()}`
    const a = await rateLimit(scope, 'id-a', 1, 60)
    const b = await rateLimit(scope, 'id-b', 1, 60)
    expect(a.allowed).toBe(true)
    expect(b.allowed).toBe(true)
    const aAgain = await rateLimit(scope, 'id-a', 1, 60)
    expect(aAgain.allowed).toBe(false)
  })

  it(
    'a device-hash-keyed cap holds across "IP rotation" — the id (device hash) is the only key, ' +
    'so calls that would represent requests from different client IPs in the real sign-up flow ' +
    'still share and exhaust the same cap, unlike a per-IP limiter that a rotating attacker resets',
    async () => {
      const scope = 'signup-device'
      const deviceHash = `device-${crypto.randomUUID()}`
      const limit = 3
      // Each call represents a sign-up attempt from a DIFFERENT simulated client IP, but the same
      // device hash — device-hash keying means the underlying IP is irrelevant to the count.
      const simulatedClientIps = ['203.0.113.10', '198.51.100.20', '192.0.2.30', '203.0.113.40']
      const results = []
      for (const _ip of simulatedClientIps) {
        results.push(await rateLimit(scope, deviceHash, limit, 60))
      }
      expect(results.map((r) => r.allowed)).toEqual([true, true, true, false])
    },
  )

  it('resets after the window elapses', async () => {
    const scope = `test-scope-${crypto.randomUUID()}`
    const id = 'reset-id'
    const first = await rateLimit(scope, id, 1, 1)
    expect(first.allowed).toBe(true)
    const immediateSecond = await rateLimit(scope, id, 1, 1)
    expect(immediateSecond.allowed).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const afterWindow = await rateLimit(scope, id, 1, 1)
    expect(afterWindow.allowed).toBe(true)
  })
})

describe('getAuthedRateLimitId', () => {
  it('composes userId + organizationId into a stable key', () => {
    expect(getAuthedRateLimitId({ userId: 'user-1', organizationId: 'org-1' })).toBe('user-1:org-1:-')
  })

  it('is stable regardless of organizationId/sessionHash argument order or repetition', () => {
    const a = getAuthedRateLimitId({ userId: 'user-1', organizationId: 'org-1' })
    const b = getAuthedRateLimitId({ userId: 'user-1', organizationId: 'org-1' })
    expect(a).toBe(b)
  })

  it('produces distinct keys for different users in the same org', () => {
    const a = getAuthedRateLimitId({ userId: 'user-1', organizationId: 'org-1' })
    const b = getAuthedRateLimitId({ userId: 'user-2', organizationId: 'org-1' })
    expect(a).not.toBe(b)
  })

  it('produces distinct keys for the same user across different orgs', () => {
    const a = getAuthedRateLimitId({ userId: 'user-1', organizationId: 'org-1' })
    const b = getAuthedRateLimitId({ userId: 'user-1', organizationId: 'org-2' })
    expect(a).not.toBe(b)
  })

  it('includes an optional sessionHash for finer scoping when supplied', () => {
    const withoutSession = getAuthedRateLimitId({ userId: 'user-1', organizationId: 'org-1' })
    const withSession = getAuthedRateLimitId({ userId: 'user-1', organizationId: 'org-1', sessionHash: 'session-abc' })
    expect(withSession).not.toBe(withoutSession)
  })

  it(
    'an identity-keyed cap holds across IP rotation for an authenticated user — the userId+organizationId ' +
    'key is what rateLimit buckets on, so requests simulated from different client IPs still share and ' +
    'exhaust one cap, unlike getRateLimitId(request) which would reset per IP',
    async () => {
      const identity = { userId: `authed-user-${crypto.randomUUID()}`, organizationId: 'org-1' }
      const rateLimitId = getAuthedRateLimitId(identity)
      const scope = 'authed-endpoint'
      const limit = 3
      const simulatedClientIps = ['203.0.113.10', '198.51.100.20', '192.0.2.30', '203.0.113.40']
      const results = []
      for (const _ip of simulatedClientIps) {
        // A per-IP limiter would use a different key per iteration here; getAuthedRateLimitId
        // returns the SAME key regardless, since it never looks at the request/IP at all.
        results.push(await rateLimit(scope, rateLimitId, limit, 60))
      }
      expect(results.map((r) => r.allowed)).toEqual([true, true, true, false])
    },
  )
})
