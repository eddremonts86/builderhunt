import { afterEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({ BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long', NODE_ENV: 'development' as 'development' | 'production' | 'test' }))
vi.mock('../env', () => ({ env: mockEnv }))

const { createStepupCookieValue, isStepupCookieValid, readCookie, requireStepUp, StepUpRequiredError, stepupSetCookieHeader, STEPUP_COOKIE_NAME } = await import('./stepup')

afterEach(() => {
  mockEnv.NODE_ENV = 'development'
})

describe('createStepupCookieValue / isStepupCookieValid', () => {
  it('validates a freshly-created cookie for the same user', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const value = createStepupCookieValue('user-1', now)
    expect(isStepupCookieValid(value, 'user-1', now)).toBe(true)
  })

  it('rejects a cookie for a different user (signature mismatch)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const value = createStepupCookieValue('user-1', now)
    expect(isStepupCookieValid(value, 'user-2', now)).toBe(false)
  })

  it('rejects once the cookie is older than the 15-minute window', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z')
    const value = createStepupCookieValue('user-1', issuedAt)
    const now = new Date(issuedAt.getTime() + 16 * 60 * 1000)
    expect(isStepupCookieValid(value, 'user-1', now)).toBe(false)
  })

  it('still validates right at the edge of the window', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z')
    const value = createStepupCookieValue('user-1', issuedAt)
    const now = new Date(issuedAt.getTime() + 14 * 60 * 1000)
    expect(isStepupCookieValid(value, 'user-1', now)).toBe(true)
  })

  it('rejects null, empty, or malformed cookie values', () => {
    expect(isStepupCookieValid(null, 'user-1')).toBe(false)
    expect(isStepupCookieValid('', 'user-1')).toBe(false)
    expect(isStepupCookieValid('not-a-valid-token', 'user-1')).toBe(false)
    expect(isStepupCookieValid('123.', 'user-1')).toBe(false)
    expect(isStepupCookieValid('not-a-number.deadbeef', 'user-1')).toBe(false)
  })

  it('rejects a tampered signature', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const value = createStepupCookieValue('user-1', now)
    const [issuedAt] = value.split('.')
    const tampered = `${issuedAt}.${'0'.repeat(64)}`
    expect(isStepupCookieValid(tampered, 'user-1', now)).toBe(false)
  })
})

describe('stepupSetCookieHeader', () => {
  it('omits Secure outside production', () => {
    mockEnv.NODE_ENV = 'development'
    const header = stepupSetCookieHeader('some-value')
    expect(header).toContain(`${STEPUP_COOKIE_NAME}=some-value`)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).not.toContain('Secure')
  })

  it('adds Secure in production', () => {
    mockEnv.NODE_ENV = 'production'
    const header = stepupSetCookieHeader('some-value')
    expect(header).toContain('Secure')
  })
})

describe('readCookie', () => {
  it('returns null for a missing header or missing cookie', () => {
    expect(readCookie(null, STEPUP_COOKIE_NAME)).toBeNull()
    expect(readCookie('other=1', STEPUP_COOKIE_NAME)).toBeNull()
  })

  it('parses the named cookie out of a multi-cookie header', () => {
    expect(readCookie(`a=1; ${STEPUP_COOKIE_NAME}=abc.def; b=2`, STEPUP_COOKIE_NAME)).toBe('abc.def')
  })
})

describe('requireStepUp', () => {
  // happy-dom's `Request` constructor strips the `Cookie` header (the Fetch spec's
  // "forbidden request header" rule, meant for outgoing fetch() calls, not inbound server
  // requests — a real server route DOES see the browser's genuine Cookie header). Duck-type a
  // minimal `{ headers: { get } }` instead of constructing a real `Request` — `requireStepUp`
  // only ever calls `request.headers.get('cookie')`.
  function requestWithCookie(cookieValue: string | null): Request {
    const cookieHeader = cookieValue ? `${STEPUP_COOKIE_NAME}=${cookieValue}` : null
    return { headers: { get: (name: string) => (name === 'cookie' ? cookieHeader : null) } } as unknown as Request
  }

  it('never throws for any stage other than stepup', () => {
    for (const stage of ['observe', 'warned', 'throttled', 'blocked'] as const) {
      expect(() => requireStepUp(requestWithCookie(null), 'user-1', stage)).not.toThrow()
    }
  })

  it('throws StepUpRequiredError at the stepup stage with no cookie', () => {
    expect(() => requireStepUp(requestWithCookie(null), 'user-1', 'stepup')).toThrow(StepUpRequiredError)
  })

  it('does not throw at the stepup stage with a valid cookie for this user', () => {
    const value = createStepupCookieValue('user-1')
    expect(() => requireStepUp(requestWithCookie(value), 'user-1', 'stepup')).not.toThrow()
  })

  it('still throws at the stepup stage with a cookie belonging to a different user', () => {
    const value = createStepupCookieValue('user-2')
    expect(() => requireStepUp(requestWithCookie(value), 'user-1', 'stepup')).toThrow(StepUpRequiredError)
  })
})
