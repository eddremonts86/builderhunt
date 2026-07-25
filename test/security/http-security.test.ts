import { describe, expect, it } from 'vitest'
import {
  applySecurityHeaders,
  isTrustedMutationOrigin,
  securityHeaderEntries,
} from '../../server/security.mjs'

/**
 * These cover `server/security.mjs`, which is the code that actually runs: `server.prod.mjs`
 * imports it for every response path and for the CSRF gate.
 *
 * They replace `src/shared/lib/security/headers.test.ts`, which tested a parallel TypeScript
 * copy that no production code imported — the enforcement was an inline duplicate in
 * `server.prod.mjs` that nothing exercised. Both copies happened to agree, but a passing suite
 * proved nothing about the shipped posture.
 *
 * The node-style header cases below are the point: `server.prod.mjs` passes an
 * `IncomingMessage`, whose `headers` is a plain object of lowercased names, not a `Headers`.
 */

const TRUSTED = 'https://builderhunt.example'

/** Shaped like a Web `Request` — how app-side callers would use it. */
const webMutation = (origin?: string, init: { cookie?: boolean } = { cookie: true }) => ({
  method: 'POST',
  headers: new Headers({
    ...(init.cookie === false ? {} : { cookie: 'session=x' }),
    ...(origin ? { origin } : {}),
  }),
})

/** Shaped like node's `IncomingMessage` — how `server.prod.mjs` actually calls it. */
const nodeMutation = (
  origin?: string | string[],
  init: { cookie?: boolean; method?: string } = {},
) => ({
  method: init.method ?? 'POST',
  headers: {
    ...(init.cookie === false ? {} : { cookie: 'session=x' }),
    ...(origin ? { origin } : {}),
  } as Record<string, string | string[] | undefined>,
})

describe('security headers', () => {
  it('emits the browser hardening set', () => {
    const headers = securityHeaderEntries({ production: true, secure: true })
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'")
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin')
  })

  it('sets HSTS only on production over https', () => {
    expect(
      securityHeaderEntries({ production: true, secure: true })['Strict-Transport-Security'],
    ).toContain('max-age=')
    expect(
      securityHeaderEntries({ production: true, secure: false })['Strict-Transport-Security'],
    ).toBeUndefined()
    expect(
      securityHeaderEntries({ production: false, secure: true })['Strict-Transport-Security'],
    ).toBeUndefined()
  })

  it('adds no CORS surface', () => {
    // The mutation-origin gate below is the only CSRF defence; an Access-Control-Allow-Origin
    // header would undercut it. Any client needing cross-origin access authenticates with a
    // bearer token instead of a cookie.
    const keys = Object.keys(securityHeaderEntries({ production: true, secure: true }))
    expect(keys.filter((k) => k.toLowerCase().startsWith('access-control-'))).toEqual([])
  })

  it('applies the same set onto a Headers instance', () => {
    const headers = applySecurityHeaders(new Headers(), { production: true, secure: true })
    const entries = securityHeaderEntries({ production: true, secure: true })
    for (const [key, value] of Object.entries(entries)) {
      expect(headers.get(key)).toBe(value)
    }
  })
})

describe('CSRF mutation-origin gate', () => {
  it('requires an exact trusted origin for cookie-authenticated mutations', () => {
    expect(isTrustedMutationOrigin(webMutation(TRUSTED), TRUSTED)).toBe(true)
    expect(isTrustedMutationOrigin(webMutation('https://evil.example'), TRUSTED)).toBe(false)
  })

  it('treats a missing Origin on a cookie mutation as untrusted', () => {
    // Every browser capable of a cross-site cookie mutation also sends Origin, so an absent
    // one is a non-browser client (which should use a bearer token) or a stripped header.
    expect(isTrustedMutationOrigin(webMutation(undefined), TRUSTED)).toBe(false)
    expect(isTrustedMutationOrigin(nodeMutation(undefined), TRUSTED)).toBe(false)
  })

  it('treats an unparseable Origin as untrusted', () => {
    expect(isTrustedMutationOrigin(webMutation('not-a-url'), TRUSTED)).toBe(false)
    expect(isTrustedMutationOrigin(webMutation('null'), TRUSTED)).toBe(false)
  })

  it('rejects a same-host origin on a different scheme or port', () => {
    expect(isTrustedMutationOrigin(webMutation('http://builderhunt.example'), TRUSTED)).toBe(false)
    expect(isTrustedMutationOrigin(webMutation('https://builderhunt.example:8443'), TRUSTED)).toBe(
      false,
    )
    expect(isTrustedMutationOrigin(webMutation('https://evil.builderhunt.example'), TRUSTED)).toBe(
      false,
    )
  })

  it('rejects an extension origin carrying a cookie', () => {
    expect(isTrustedMutationOrigin(webMutation('chrome-extension://abcdef'), TRUSTED)).toBe(false)
    expect(isTrustedMutationOrigin(webMutation('moz-extension://abcdef'), TRUSTED)).toBe(false)
  })

  it('skips the check for safe methods and bearer-only requests', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options']) {
      expect(isTrustedMutationOrigin(nodeMutation('https://evil.example', { method }), TRUSTED)).toBe(
        true,
      )
    }
    // No cookie: not CSRF-exposed. Its own bearer-token check authorizes it.
    expect(isTrustedMutationOrigin(webMutation(undefined, { cookie: false }), TRUSTED)).toBe(true)
    expect(
      isTrustedMutationOrigin(nodeMutation('https://evil.example', { cookie: false }), TRUSTED),
    ).toBe(true)
  })

  it('reads node-style headers, including repeated ones', () => {
    // `server.prod.mjs` hands us `IncomingMessage` directly, so a plain lowercased-key object
    // and array-valued repeated headers must behave identically to a Headers instance.
    expect(isTrustedMutationOrigin(nodeMutation(TRUSTED), TRUSTED)).toBe(true)
    expect(isTrustedMutationOrigin(nodeMutation('https://evil.example'), TRUSTED)).toBe(false)
    expect(isTrustedMutationOrigin(nodeMutation([TRUSTED, 'https://evil.example']), TRUSTED)).toBe(
      true,
    )
    expect(isTrustedMutationOrigin(nodeMutation(['https://evil.example', TRUSTED]), TRUSTED)).toBe(
      false,
    )
  })

  it('accepts a trusted origin given with a path, as PUBLIC_ORIGIN.href is', () => {
    // server.prod.mjs passes `new URL(APP_URL).href`, which normalizes to a trailing slash.
    expect(isTrustedMutationOrigin(webMutation(TRUSTED), `${TRUSTED}/`)).toBe(true)
  })

  it('defaults a missing method to GET rather than failing open on a mutation', () => {
    expect(isTrustedMutationOrigin({ headers: new Headers({ cookie: 'session=x' }) }, TRUSTED)).toBe(
      true,
    )
  })
})
