/**
 * The single implementation of BuilderHunt's HTTP security posture.
 *
 * This lives in plain ESM, outside `src/`, for one reason: `server.prod.mjs` is the real
 * enforcement point and the runtime Docker stage does not copy `src/` (see Dockerfile). A
 * TypeScript module could not be imported by the production entrypoint, which is exactly how
 * this logic previously ended up duplicated — a tested copy in `src/shared/lib/security/` that
 * nothing imported, and an untested inline copy in `server.prod.mjs` that actually shipped.
 *
 * Tests: `test/security-headers.test.ts`. Types: `server/security.d.mts`.
 *
 * Enforcement covers request paths the app handler never sees (static assets, the 403 below,
 * and the 500 emitted when `app.fetch` throws), so it cannot move into the app.
 */

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  'upgrade-insecure-requests',
].join('; ')

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

/**
 * The security headers as a plain object, for `res.writeHead()`.
 *
 * Deliberately emits no `Access-Control-Allow-*` header: the app has no CORS surface, and the
 * mutation-origin check below is the only CSRF gate, so adding one would weaken it.
 */
export function securityHeaderEntries({ production, secure }) {
  const headers = {
    'Content-Security-Policy': contentSecurityPolicy,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
  if (production && secure) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  }
  return headers
}

/** Same header set, applied onto a Web `Headers` instance. */
export function applySecurityHeaders(headers, options) {
  for (const [key, value] of Object.entries(securityHeaderEntries(options))) {
    headers.set(key, value)
  }
  return headers
}

/**
 * Reads one header from either a Web `Headers` instance or node's plain `req.headers` object.
 * Node lowercases incoming header names and may hand back an array for repeated headers.
 */
function readHeader(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (value == null) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

/**
 * CSRF gate for cookie-authenticated mutations.
 *
 * Accepts anything shaped `{ method, headers }` — a Web `Request`, or node's `IncomingMessage`.
 *
 * A missing or unparseable `Origin` on a cookie-bearing mutation is UNTRUSTED. Every browser
 * that can send a cookie on a cross-site mutation also sends `Origin`, so an absent one is
 * either a non-browser client (which should authenticate with a bearer token instead of a
 * cookie) or a stripped header — neither earns the benefit of the doubt.
 *
 * Bearer-only requests carry no cookie and are therefore not CSRF-exposed; they pass here and
 * are authorized by their own token check.
 */
export function isTrustedMutationOrigin(request, trustedOrigin) {
  const method = (request.method ?? 'GET').toUpperCase()
  if (SAFE_METHODS.includes(method)) return true

  const cookie = readHeader(request.headers, 'cookie')
  if (!cookie) return true

  const origin = readHeader(request.headers, 'origin')
  if (!origin) return false

  try {
    return new URL(origin).origin === new URL(trustedOrigin).origin
  } catch {
    return false
  }
}
