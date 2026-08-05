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

/**
 * The site-wide policy, as a directive map rather than a joined string.
 *
 * A map because there is now a second, stricter variant for the candidate-facing scheduling
 * surface, and the plan for it was explicit: "its CSP is a single shared constant, so a stricter
 * per-route scheduling CSP means adding a named variant export there — do not fork a second copy."
 * Overriding named keys cannot drift from the base; a forked string silently can.
 */
const BASE_CSP_DIRECTIVES = {
  'default-src': "'self'",
  'base-uri': "'self'",
  'object-src': "'none'",
  'frame-ancestors': "'none'",
  'form-action': "'self'",
  'script-src': "'self' 'unsafe-inline'",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data: https:",
  'font-src': "'self' data:",
  'connect-src': "'self' https:",
  'upgrade-insecure-requests': '',
}

function serializeCsp(directives) {
  return Object.entries(directives)
    .map(([name, value]) => (value ? `${name} ${value}` : name))
    .join('; ')
}

const contentSecurityPolicy = serializeCsp(BASE_CSP_DIRECTIVES)

/**
 * Paths whose responses belong to a candidate who has no account, reached through a one-time
 * capability in a URL fragment.
 *
 * Trailing slashes are deliberate: `/schedule/` must not match a future `/schedules-report`, and a
 * prefix that broad is how a strict policy ends up applied somewhere it breaks.
 */
export const PUBLIC_SCHEDULING_PATH_PREFIXES = ['/schedule/', '/api/public/scheduling/']

export function isPublicSchedulingPath(pathname) {
  if (typeof pathname !== 'string') return false
  return PUBLIC_SCHEDULING_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/**
 * The stricter variant for public scheduling responses.
 *
 * Three directives tighten, and each one is a claim about that page that was checked rather than
 * assumed:
 *
 * - `img-src` drops `https:`. The candidate portal renders no remote image — no avatar, no tracking
 *   pixel — so a remote image load there would be a bug or an injection, not a feature.
 * - `frame-src` becomes `'none'`, down from the `'self'` it inherits via `default-src`. Nothing in
 *   `src/modules/scheduling/components/` mounts an iframe.
 * - `connect-src` drops the blanket `https:` and names exactly one extra origin: the object-storage
 *   endpoint. **It cannot be `'self'` alone.** `DocumentUploader.tsx` PUTs the candidate's file
 *   straight to a presigned URL on `INTERVIEW_R2_ENDPOINT`, so `'self'` would break the upload —
 *   which is the mistake a "tighten the CSP" change invites, and the reason this takes the origin as
 *   an argument instead of hard-coding one.
 *
 * `script-src` keeps `'unsafe-inline'`: the app is SSR and its hydration payload is an inline
 * script. Removing it needs a nonce pipeline through the renderer, which is a different change.
 */
export function publicSchedulingContentSecurityPolicy({ uploadOrigin } = {}) {
  const connect = uploadOrigin ? `'self' ${uploadOrigin}` : "'self'"
  return serializeCsp({
    ...BASE_CSP_DIRECTIVES,
    'img-src': "'self' data:",
    'frame-src': "'none'",
    'connect-src': connect,
  })
}

/**
 * The browser-reachable origin of the object store, for `connect-src`.
 *
 * Returns null for anything unparseable rather than throwing: a malformed endpoint must not take the
 * whole response down, and the fallback (`connect-src 'self'`) fails closed — uploads break loudly
 * instead of the policy silently permitting everything.
 */
export function uploadOriginFrom(endpoint) {
  if (!endpoint) return null
  try {
    return new URL(endpoint).origin
  } catch {
    return null
  }
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

/**
 * The security headers as a plain object, for `res.writeHead()`.
 *
 * Deliberately emits no `Access-Control-Allow-*` header: the app has no CORS surface, and the
 * mutation-origin check below is the only CSRF gate, so adding one would weaken it.
 */
export function securityHeaderEntries({ production, secure, pathname, uploadOrigin }) {
  const publicScheduling = isPublicSchedulingPath(pathname)
  const headers = {
    'Content-Security-Policy': publicScheduling
      ? publicSchedulingContentSecurityPolicy({ uploadOrigin })
      : contentSecurityPolicy,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
  if (publicScheduling) {
    // The capability is in the URL fragment, so it never reaches a server log — but a referer would
    // carry the path, and the path names an invitation. `no-referrer` is stricter than the site-wide
    // `strict-origin-when-cross-origin` and is what `src/routes/schedule/$invitationId.tsx` already
    // asks for via a meta tag; this makes it a header, which the meta tag cannot be for an API
    // response.
    headers['Referrer-Policy'] = 'no-referrer'
    // A candidate's invitation must not sit in a shared or proxy cache. Set here rather than
    // per-route because `server.prod.mjs` applies this set *over* the route's own headers, so a
    // route-level value would be overwritten in production and hold only in dev.
    headers['Cache-Control'] = 'no-store'
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
