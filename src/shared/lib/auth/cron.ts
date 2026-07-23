import { createHash, timingSafeEqual } from 'node:crypto'

import type { PlatformAdminPrincipal } from './platform-admin'

/**
 * Unattended worker authorization via a shared CRON_SECRET.
 *
 * The run-worker endpoints (src/routes/api/admin/(*)/run-worker.ts) are
 * normally gated by requirePlatformAdminPrincipal — a browser session on the
 * platform-admin allow-list. A VPS crontab has no session, so this lets a
 * scheduler authenticate with the CRON_SECRET instead, WITHOUT weakening the
 * admin path: it only ADDS a machine identity ({ userId: 'cron' }) and is a
 * no-op (returns null → fall through to the session check) whenever the secret
 * is unset or the request presents no / a wrong token.
 *
 * Send the secret as `Authorization: Bearer <CRON_SECRET>` or
 * `X-Cron-Secret: <CRON_SECRET>`.
 */

function requestIdFrom(request: Request): string {
  const candidate = request.headers.get('x-request-id')
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID()
}

function presentedToken(request: Request): string | null {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer) return bearer.trim()
  const header = request.headers.get('x-cron-secret')
  return header ? header.trim() : null
}

// Constant-time comparison over fixed-length SHA-256 digests. timingSafeEqual
// throws on unequal lengths, so hashing first normalizes the length and avoids
// leaking the secret length through timing.
function secretsMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

export function tryCronPrincipal(request: Request): PlatformAdminPrincipal | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return null
  const token = presentedToken(request)
  if (!token) return null
  return secretsMatch(token, secret) ? { userId: 'cron', requestId: requestIdFrom(request) } : null
}
