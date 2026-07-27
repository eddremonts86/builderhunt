/**
 * The candidate's browser session (plan: calendar-scheduling-interview-intelligence, Phase 5
 * "Implement capability exchange and session validation"; spec.md §"Public capability security").
 *
 * The secret arrives in a URL *fragment*, which never reaches a server, never lands in an access log
 * and never appears in a `Referer`. The candidate's page reads it, POSTs it once to `.../session`,
 * and replaces its own history entry so the back button cannot resurrect it. From then on the
 * browser proves who it is with a cookie.
 *
 * Four properties of that cookie are load-bearing:
 *
 * 1. **`HttpOnly`.** The portal's own JavaScript has no reason to read the secret after the exchange,
 *    and an XSS in any dependency on that page would otherwise walk away with a working capability.
 * 2. **Path-scoped to the one invitation.** `Path=/api/public/scheduling/<id>` means the browser
 *    will not attach this capability to a request about a different invitation, so a bug in a
 *    handler cannot turn one candidate's cookie into access to another's booking. The scoping is
 *    enforced by the browser, before our code runs.
 * 3. **`SameSite=Strict`.** The candidate always arrives by typing or clicking a link from their own
 *    mail client into the address bar, so no legitimate flow is cross-site. Combined with the
 *    existing mutation-origin gate this leaves no cross-site path to a booking.
 * 4. **Short-lived.** The cookie outlives a booking session, not a hiring process. Losing it costs
 *    the candidate one click on the original email link; leaving it valid for weeks costs
 *    considerably more on a shared machine.
 *
 * The cookie carries the secret itself rather than a session id. There is no server-side session
 * store in this design, and a signed id would need a revocation list to answer "was this invitation
 * revoked?" — whereas the secret hashes straight to the row, and a revoked row simply stops
 * resolving. See `capability.ts` for why the stored value is a hash.
 */
import { env } from '~/shared/lib/env'

const COOKIE_PREFIX = 'bh_sched'

/** Eight hours: long enough to read a privacy notice properly, short enough not to linger on a shared laptop. */
export const CAPABILITY_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60

/**
 * One cookie name per invitation.
 *
 * Two invitations open in two tabs is a real thing — a candidate interviewing at two teams in one
 * organization — and a single shared cookie name would have the second exchange silently overwrite
 * the first. Path scoping alone would not save it, since both paths share the same prefix segment.
 */
export function capabilitySessionCookieName(invitationId: string): string {
  return `${COOKIE_PREFIX}_${invitationId.replace(/-/g, '')}`
}

function cookiePath(invitationId: string): string {
  return `/api/public/scheduling/${invitationId}`
}

export function capabilitySessionSetCookie(invitationId: string, secret: string): string {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : ''
  return [
    `${capabilitySessionCookieName(invitationId)}=${secret}`,
    `Max-Age=${CAPABILITY_SESSION_MAX_AGE_SECONDS}`,
    `Path=${cookiePath(invitationId)}`,
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ') + secure
}

/** Clears the session — used on decline and on a revoked/expired invitation, so a dead capability stops being resent. */
export function capabilitySessionClearCookie(invitationId: string): string {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : ''
  return [
    `${capabilitySessionCookieName(invitationId)}=`,
    'Max-Age=0',
    `Path=${cookiePath(invitationId)}`,
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ') + secure
}

/**
 * Extracts this invitation's capability from a request's `Cookie` header.
 *
 * Parses by exact name match rather than a regex over the whole header, because a cookie whose name
 * merely *ends* with ours — set by anything else on the domain — must not be mistaken for it.
 */
export function readCapabilitySessionCookie(request: Request, invitationId: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  const wanted = capabilitySessionCookieName(invitationId)
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== wanted) continue
    const value = part.slice(separator + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}
