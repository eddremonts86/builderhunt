import { env } from '~/shared/lib/env'

/**
 * Origin checking for state-changing requests.
 *
 * ## Why this exists when the session cookie is already `SameSite=Lax`
 *
 * Lax is the primary defence and it does block a cross-site POST. This is the second layer, and it is
 * worth having for one reason: the cookie policy is a single line in the auth configuration, and a change
 * to it — for an embed, an OAuth flow, a third-party integration — would silently remove CSRF protection
 * from every mutating endpoint at once, with nothing failing. A check in the request path fails loudly
 * instead.
 *
 * ## `Sec-Fetch-Site` first, `Origin` as the fallback
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be forged by page script, which makes it the stronger
 * signal where it exists. `Origin` is the fallback for anything that does not send it. A request with
 * neither is *rejected* rather than allowed: a browser sends at least one on a cross-origin POST, so
 * their joint absence means this is not the browser request the endpoint is written for.
 */
export class CrossOriginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CrossOriginError'
  }
}

/** Throws unless the request came from this application's own origin. */
export function assertSameOrigin(request: Request): void {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null) {
    // `none` is a direct navigation, which cannot be a JSON POST from another site.
    if (fetchSite === 'same-origin' || fetchSite === 'none') return
    throw new CrossOriginError(`cross-origin request refused (sec-fetch-site: ${fetchSite})`)
  }

  const origin = request.headers.get('origin')
  if (origin === null) {
    throw new CrossOriginError('request carried neither sec-fetch-site nor origin')
  }
  if (normalizeOrigin(origin) !== normalizeOrigin(env.APP_URL)) {
    throw new CrossOriginError('cross-origin request refused')
  }
}

/**
 * Compares protocol, host and port only.
 *
 * A path or trailing slash on the configured `APP_URL` must not make every request look cross-origin —
 * that would be an outage caused by a formatting difference in an environment variable.
 */
function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    // Unparseable, so it can never equal a parsed origin. Returning the raw string keeps the comparison
    // total instead of throwing out of a security check.
    return value
  }
}

/**
 * Throws unless the body is JSON.
 *
 * On the interview endpoints this is also the audio refusal: `audio/webm`, `multipart/form-data` and
 * `application/octet-stream` are all rejected here, before any handler could accept a byte of it. The
 * schema's `.strict()` refuses an `audio` *field*; this refuses an audio *body*.
 */
export function assertJsonRequest(request: Request): void {
  const contentType = request.headers.get('content-type') ?? ''
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new CrossOriginError(`expected application/json, received ${mediaType || 'no content type'}`)
  }
}
