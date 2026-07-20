import { describe, expect, it } from 'vitest'
import { applySecurityHeaders, isTrustedMutationOrigin } from './headers'

describe('HTTP security policy', () => {
  it('applies browser hardening headers', () => {
    const headers = applySecurityHeaders(new Headers(), { production: true, secure: true })
    expect(headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('x-frame-options')).toBe('DENY')
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('strict-transport-security')).toContain('max-age=')
  })

  it('requires an exact trusted origin for cookie-authenticated mutations', () => {
    const trusted = 'https://builderhunt.example'
    const mutation = (origin?: string) => ({
      method: 'POST',
      headers: new Headers({ cookie: 'session=x', ...(origin ? { origin } : {}) }),
    }) as Request
    expect(isTrustedMutationOrigin(mutation(trusted), trusted)).toBe(true)
    expect(isTrustedMutationOrigin(mutation('https://evil.example'), trusted)).toBe(false)
    expect(isTrustedMutationOrigin(mutation(), trusted)).toBe(false)
  })

  it('does not require CSRF origin checks for safe or bearer-only requests', () => {
    expect(isTrustedMutationOrigin(new Request('https://builderhunt.example/api/x'), 'https://builderhunt.example')).toBe(true)
    expect(isTrustedMutationOrigin(new Request('https://builderhunt.example/api/x', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
    }), 'https://builderhunt.example')).toBe(true)
  })
})
