import { createHmac, randomUUID } from 'node:crypto'

/** First-party cookie name for the device-recognition identifier. */
export const DEVICE_COOKIE_NAME = 'bh_did'

export function issueDeviceCookieValue(): string {
  return randomUUID()
}

const UA_FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/edg\//i, 'edge'],
  [/crios\//i, 'chrome'],
  [/fxios\//i, 'firefox'],
  [/chrome\//i, 'chrome'],
  [/firefox\//i, 'firefox'],
  [/safari\//i, 'safari'],
]

/** Coarse family bucketing only — never a raw fingerprint. */
export function detectUaFamily(userAgent: string | null | undefined): string {
  if (!userAgent) return 'unknown'
  for (const [pattern, family] of UA_FAMILY_PATTERNS) {
    if (pattern.test(userAgent)) return family
  }
  return 'other'
}

/**
 * Stable per-(cookie, UA family) hash, salted with a server secret so the
 * stored `device_hash` can't be reversed to the raw cookie value even if the
 * database leaks. Same HMAC-with-caller-supplied-secret convention as
 * `security/feed-capability.ts`'s `sign()` — never reads `env` directly, so
 * this stays a pure, easily testable function.
 */
export function computeDeviceHash(cookieValue: string, uaFamily: string, salt: string): string {
  return createHmac('sha256', salt).update(`builderhunt:device:v1:${cookieValue}:${uaFamily}`).digest('hex')
}
