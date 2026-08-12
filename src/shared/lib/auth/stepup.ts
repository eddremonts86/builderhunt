import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../env'

/**
 * Step-up re-authentication (abuse-and-usage-integrity plan, Phase 5's second task). At the
 * `'stepup'` enforcement stage, a user must re-verify their password (`auth.api.verifyPassword` —
 * confirmed to already exist in better-auth core, no new dependency) before continuing. There is
 * no persisted "verified at" column anywhere in this codebase (`auth_sessions`/`auth_users`/
 * `account_risk` all lack one — confirmed by research before writing this) and the existing
 * "recent auth" convention (`billing/permissions.ts`'s `requireRecentBillingAuthentication`) means
 * something different — "this session was CREATED within the last 15 minutes" (derived from
 * `auth_sessions.created_at`), not "the user re-typed their password." Rather than add a new
 * migration for something this short-lived and session-scoped, step-up verification is recorded in
 * a signed, time-boxed HttpOnly cookie (same HMAC-with-server-secret convention as
 * `abuse/device.ts`'s `computeDeviceHash`), verified with a constant-time comparison.
 */

export const STEPUP_COOKIE_NAME = 'bh_stepup'
const STEPUP_MAX_AGE_SECONDS = 15 * 60

function sign(userId: string, issuedAtMs: number): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET ?? '')
    .update(`builderhunt:stepup:v1:${userId}:${issuedAtMs}`)
    .digest('hex')
}

/** The raw cookie value to set after a successful password re-verification. */
export function createStepupCookieValue(userId: string, now: Date = new Date()): string {
  const issuedAtMs = now.getTime()
  return `${issuedAtMs}.${sign(userId, issuedAtMs)}`
}

/** `Set-Cookie` header value for `createStepupCookieValue`'s output. */
export function stepupSetCookieHeader(cookieValue: string): string {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${STEPUP_COOKIE_NAME}=${cookieValue}; Max-Age=${STEPUP_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`
}

/** True if `cookieValue` (as read from the request's `Cookie` header) is a still-valid step-up token for `userId`. */
export function isStepupCookieValid(cookieValue: string | null | undefined, userId: string, now: Date = new Date()): boolean {
  if (!cookieValue) return false
  const [issuedAtRaw, signature] = cookieValue.split('.')
  if (!issuedAtRaw || !signature) return false
  const issuedAtMs = Number(issuedAtRaw)
  if (!Number.isFinite(issuedAtMs)) return false
  if ((now.getTime() - issuedAtMs) / 1000 > STEPUP_MAX_AGE_SECONDS) return false

  const expected = sign(userId, issuedAtMs)
  const expectedBuffer = Buffer.from(expected, 'hex')
  const actualBuffer = Buffer.from(signature, 'hex')
  if (expectedBuffer.length !== actualBuffer.length) return false
  return timingSafeEqual(expectedBuffer, actualBuffer)
}

/** Parses one named cookie out of a request's raw `Cookie` header. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

export class StepUpRequiredError extends Error {
  constructor() {
    super('Step-up re-authentication is required before this action')
    this.name = 'StepUpRequiredError'
  }
}

/**
 * Reusable guard for a "sensitive action" route to call before proceeding: throws
 * `StepUpRequiredError` if the caller's enforcement stage is `'stepup'` and no valid `bh_stepup`
 * cookie is present (i.e. they have not yet completed `POST /api/me/stepup`). A no-op for every
 * other stage. Not wired into a specific route yet — `plans/implemented/32-abuse-and-usage-integrity/tasks.md`'s
 * own task text doesn't name one; this is the primitive ready for whichever sensitive action
 * needs it.
 */
export function requireStepUp(request: Request, userId: string, stage: 'observe' | 'warned' | 'stepup' | 'throttled' | 'blocked'): void {
  if (stage !== 'stepup') return
  const cookieValue = readCookie(request.headers.get('cookie'), STEPUP_COOKIE_NAME)
  if (!isStepupCookieValid(cookieValue, userId)) throw new StepUpRequiredError()
}
