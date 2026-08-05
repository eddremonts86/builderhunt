import { describe, expect, it } from 'vitest'
import {
  applySecurityHeaders,
  isPublicSchedulingPath,
  isTrustedMutationOrigin,
  publicSchedulingContentSecurityPolicy,
  securityHeaderEntries,
  uploadOriginFrom,
} from '../../../server/security.mjs'

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

/**
 * The stricter policy for the candidate-facing scheduling surface
 * (plans/phase-1/44-calendar-scheduling-interview-intelligence, "Implement capability exchange and
 * session validation" — the one part of that task still open until 2026-08-05).
 *
 * The load-bearing case is the last one. `DocumentUploader.tsx` PUTs the candidate's file straight to
 * a presigned URL on another origin, so a policy that tightened `connect-src` all the way to `'self'`
 * would pass every test written about *headers* and break the upload in production. These assert the
 * upload origin survives.
 */
describe('public scheduling CSP', () => {
  const strict = (pathname: string, uploadOrigin?: string | null) =>
    securityHeaderEntries({ production: true, secure: true, pathname, uploadOrigin })

  it('matches the candidate page and the public API, and nothing that merely looks like them', () => {
    expect(isPublicSchedulingPath('/schedule/inv_123')).toBe(true)
    expect(isPublicSchedulingPath('/api/public/scheduling/inv_123/slots')).toBe(true)
    // The trailing slash in the prefix is what makes these false.
    expect(isPublicSchedulingPath('/schedules-report')).toBe(false)
    expect(isPublicSchedulingPath('/api/scheduling/invitations')).toBe(false)
    expect(isPublicSchedulingPath('/assets/index-a1b2c3d4.js')).toBe(false)
    expect(isPublicSchedulingPath(undefined)).toBe(false)
  })

  it('leaves every other path on the site-wide policy', () => {
    const site = securityHeaderEntries({ production: true, secure: true, pathname: '/dashboard' })
    expect(site['Content-Security-Policy']).toContain("img-src 'self' data: https:")
    expect(site['Content-Security-Policy']).toContain("connect-src 'self' https:")
    expect(site['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(site['Cache-Control']).toBeUndefined()
  })

  it('drops remote images and iframes on the candidate surface', () => {
    const csp = strict('/schedule/inv_123')['Content-Security-Policy']
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).not.toContain("img-src 'self' data: https:")
    expect(csp).toContain("frame-src 'none'")
  })

  it('adds no-referrer and no-store, which a route header cannot do in production', () => {
    const headers = strict('/api/public/scheduling/inv_123/slots')
    expect(headers['Referrer-Policy']).toBe('no-referrer')
    expect(headers['Cache-Control']).toBe('no-store')
  })

  it('keeps the shared base directives rather than forking them', () => {
    const csp = strict('/schedule/inv_123')['Content-Security-Policy']
    for (const directive of [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      // SSR inlines its hydration payload; removing this needs a nonce pipeline, not a CSP edit.
      "script-src 'self' 'unsafe-inline'",
      'upgrade-insecure-requests',
    ]) {
      expect(csp).toContain(directive)
    }
  })

  it('names the object-storage origin in connect-src, so candidate uploads still work', () => {
    const csp = strict('/schedule/inv_123', 'https://files.builderhunt.example')['Content-Security-Policy']
    expect(csp).toContain("connect-src 'self' https://files.builderhunt.example")
  })

  it('falls back to \'self\' when no upload origin is configured, failing closed', () => {
    const csp = strict('/schedule/inv_123', null)['Content-Security-Policy']
    expect(csp).toContain("connect-src 'self';")
    expect(csp).not.toContain('connect-src \'self\' https:')
  })

  it('reduces a full endpoint URL to its origin, and refuses a malformed one', () => {
    expect(uploadOriginFrom('http://minio:9000/bucket/path')).toBe('http://minio:9000')
    expect(uploadOriginFrom('https://x.eu.r2.cloudflarestorage.com')).toBe('https://x.eu.r2.cloudflarestorage.com')
    expect(uploadOriginFrom('not a url')).toBeNull()
    expect(uploadOriginFrom(undefined)).toBeNull()
  })

  it('emits a syntactically well-formed policy with no empty directive', () => {
    const csp = publicSchedulingContentSecurityPolicy({ uploadOrigin: 'https://files.example' })
    for (const directive of csp.split('; ')) {
      expect(directive.trim()).not.toBe('')
      expect(directive).not.toMatch(/ {2}/)
    }
  })
})
