/**
 * Shared plumbing for the public scheduling routes (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Add public invitation and booking APIs").
 *
 * Lives outside `src/routes/` on purpose: everything in the route directory is a route, and this is
 * not one.
 *
 * The value of having it here is that every public endpoint gets the *same* gate in the *same*
 * order — feature flag, mutation origin, rate limit, cookie, capability, tenant — rather than seven
 * handlers each remembering to do six things. The one that is easiest to forget and most costly to
 * omit is the rate limit, because these endpoints are unauthenticated by design.
 */
import { isTrustedMutationOrigin } from '../../../server/security.mjs'
import { CANDIDATE_NOTICE_VERSION } from '~/shared/lib/consent-notice'
import { env } from '~/shared/lib/env'
import { getRateLimitId, rateLimit } from '~/shared/lib/rate-limit'
import type { ConsentPurpose, PublicSchedulingErrorCode } from '~/shared/lib/scheduling'
import { resolveRequiredConsentPurposes } from '~/shared/lib/scheduling'
import { SITE_URL } from '~/shared/lib/site-url'
import { readCapabilitySessionCookie } from './capability-session'
import { withCapabilityContext, type CapabilityContextResult, type CapabilityTenant } from './capability-context'
import type { CapabilityTransaction } from '~/shared/lib/db/capability-db'

/**
 * Every purpose is required to book.
 *
 * spec.md is unambiguous: booking "requires affirmative acceptance of the current terms/privacy
 * notice and separate, unticked, versioned consent for candidate-document processing, approved
 * public-web import, AI-assisted interview preparation/reporting, and transient live-audio
 * transcription", and "the public portal cannot confirm a slot until every required purpose is
 * accepted". The shared `resolveRequiredConsentPurposes` supports a narrower per-booking set for
 * later flows that genuinely invoke fewer features; this product decision is that a BuilderHunt
 * interview invokes all of them.
 */
export const BOOKING_REQUIRED_PURPOSES: readonly ConsentPurpose[] = resolveRequiredConsentPurposes({
  includesDocumentUpload: true,
  includesWebImport: true,
  includesAiAssistance: true,
  includesLiveTranscription: true,
})

export const CANDIDATE_NOTICE = CANDIDATE_NOTICE_VERSION

/**
 * Rate limits, per capability and per IP.
 *
 * Tighter on mutations than on reads: a candidate legitimately reloads the slot list while changing
 * timezone or scrolling weeks, but nobody legitimately submits forty bookings.
 */
const READ_LIMIT = { limit: 120, windowSeconds: 60 }
const WRITE_LIMIT = { limit: 20, windowSeconds: 60 }

/**
 * The public error vocabulary, mapped to status codes.
 *
 * `invitation_unavailable` is 404 for every reason an invitation did not resolve — unknown, revoked,
 * expired, or a capability for a different invitation. spec.md requires non-enumerating responses,
 * and a 403-for-revoked would tell whoever holds a forwarded email what the organizer decided.
 */
export function publicStatusFor(code: PublicSchedulingErrorCode): number {
  switch (code) {
    case 'invitation_unavailable': return 404
    case 'slot_unavailable': return 409
    case 'consent_required': return 422
    case 'rate_limited': return 429
    default: return 400
  }
}

export function publicError(code: PublicSchedulingErrorCode, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: code, ...extra }, { status: publicStatusFor(code) })
}

/**
 * Headers for every public scheduling response.
 *
 * `no-referrer` rather than the site-wide `strict-origin-when-cross-origin`: the candidate's URL
 * carries an invitation id, and a portal page that links out — to a meeting URL, to the privacy
 * notice — must not hand that id to the destination. `no-store` because a shared or corporate proxy
 * caching a page about someone's interview is exactly the leak this flow is built to avoid.
 */
export function publicSchedulingHeaders(): HeadersInit {
  return {
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  }
}

export function withPublicHeaders(response: Response, extraSetCookie?: string): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(publicSchedulingHeaders())) headers.set(key, value)
  if (extraSetCookie) headers.append('set-cookie', extraSetCookie)
  return new Response(response.body, { status: response.status, headers })
}

export function schedulingDisabled(): boolean {
  return env.SCHEDULING_ENABLED === 'false'
}

/**
 * The gate every public handler runs before touching the database.
 *
 * Returns a `Response` when the request must be refused, or `null` to continue. Written this way
 * rather than by throwing so a handler cannot accidentally swallow the refusal in a `catch` that was
 * meant for database errors.
 */
export async function guardPublicRequest(request: Request, isMutation: boolean): Promise<Response | null> {
  if (schedulingDisabled()) {
    return withPublicHeaders(Response.json({ error: 'dependency_unavailable' }, { status: 503 }))
  }
  // The cookie is the only credential here, so every mutation is CSRF-exposed and goes through the
  // same origin gate as the rest of the app's cookie-authenticated surface.
  if (isMutation && !isTrustedMutationOrigin(request, SITE_URL)) {
    return withPublicHeaders(Response.json({ error: 'forbidden' }, { status: 403 }))
  }
  const budget = isMutation ? WRITE_LIMIT : READ_LIMIT
  const outcome = await rateLimit('public-scheduling', getRateLimitId(request), budget.limit, budget.windowSeconds)
  if (!outcome.allowed) return withPublicHeaders(publicError('rate_limited'))
  return null
}

export interface CapabilityRequestContext {
  transaction: CapabilityTransaction
  tenant: CapabilityTenant
}

/**
 * Resolves the request's capability and runs `operation` inside its tenant.
 *
 * The secret comes from the cookie, never from the URL or the body: a secret in a query string ends
 * up in access logs, browser history, and any `Referer` the page emits. The one endpoint that
 * accepts it in a body is `session`, which exists precisely to move it out of the fragment and into
 * the cookie.
 */
export async function withCapabilityRequest<T>(
  request: Request,
  invitationId: string,
  operation: (context: CapabilityRequestContext) => Promise<T>,
): Promise<CapabilityContextResult<T>> {
  const secret = readCapabilitySessionCookie(request, invitationId)
  if (!secret) return { ok: false, code: 'invitation_unavailable' }
  return withCapabilityContext(
    secret,
    (transaction, tenant) => operation({ transaction, tenant }),
    { invitationId },
  )
}
