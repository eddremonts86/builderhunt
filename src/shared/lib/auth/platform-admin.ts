import { emitSecurityAudit } from '../security/audit'
import { createDatabaseSecurityAuditSink } from '../security/audit-sink'
import * as schema from '../db/schema'
import { workerDb } from '../db/worker-db'

/**
 * Platform-admin actions land in `security_audit_events` as real rows, not just log lines.
 *
 * They were console-only until 2026-08-03, which was a gap rather than a decision: this is the audit trail for
 * the most privileged actor in the system — granting an entitlement with no payment behind it, revoking a claim,
 * pausing a worker — and a trail that exists only in stdout cannot answer a question asked a month later.
 * `organization-lifecycle.ts` had already been moved to the durable sink; this call site was left behind.
 *
 * ## Why `workerDb` and not a new grant
 *
 * The table's privilege split is deliberate: `builderhunt_auth`/`_app`/`_worker` hold INSERT and no SELECT,
 * `builderhunt_platform`/`_platform_admin` hold SELECT and no INSERT. A trail the reading role can also write is
 * one it can tamper with, and a trail the request path can read is one it can leak.
 *
 * Granting `builderhunt_platform` INSERT would have collapsed that split for the one role that can read
 * everything. `builderhunt_worker` already has INSERT, and a platform-admin action is exactly what that identity
 * is for — privileged and outside any single tenant's scope. So this needs no migration and changes no
 * privilege.
 *
 * A failed insert never propagates (see `createDatabaseSecurityAuditSink`): every caller is recording something
 * that already happened, and turning a bookkeeping failure into a user-visible error would leave the action
 * committed *and* unrecorded.
 */
const platformAdminAuditSink = createDatabaseSecurityAuditSink(async (event) => {
  await workerDb.insert(schema.securityAuditEvents).values({
    id: event.id,
    organizationId: event.organizationId,
    actorUserId: event.actorUserId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    result: event.result,
    requestId: event.requestId,
    details: event.details,
    createdAt: event.createdAt,
  })
})
import { RECENT_AUTH_MAX_AGE_SECONDS } from './organization-lifecycle'

/**
 * Platform admin is a distinct, server-verified principal — never an
 * organization role. It previously leaked into every `src/routes/api/admin/**`
 * handler as its own inline `ADMIN_USER_IDS` parse + `isAdmin()` check
 * (duplicated ~16 times); centralizing it here means the allow-list is
 * parsed once and every admin mutation gets the same audit trail.
 */

export interface PlatformAdminPrincipal {
  userId: string
  requestId: string
  /**
   * When the session itself was created — absent for a machine caller (`tryCronPrincipal`'s
   * `{ userId: 'cron' }`), which has no browser session to be recent or stale; a secret-bearing
   * cron request is already strongly authenticated on its own terms. Present for a real browser
   * session, and required by `requireRecentPlatformAdminAuthentication`.
   */
  authenticatedAt?: Date
}

export interface PlatformAdminSessionScope {
  userId: string
  authenticatedAt?: Date
}

export interface PlatformAdminDependencies {
  getSession(request: Request): Promise<PlatformAdminSessionScope | null>
  isAdminUserId(userId: string): boolean
}

export class PlatformAdminAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message)
    this.name = 'PlatformAdminAuthorizationError'
  }
}

export function parseAdminUserIds(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )
}

function requestIdFrom(request: Request): string {
  const candidate = request.headers.get('x-request-id')
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID()
}

export async function resolvePlatformAdminPrincipal(
  request: Request,
  dependencies: PlatformAdminDependencies,
): Promise<PlatformAdminPrincipal> {
  const session = await dependencies.getSession(request)
  if (!session) throw new PlatformAdminAuthorizationError('Authentication required', 401)
  if (!dependencies.isAdminUserId(session.userId)) {
    throw new PlatformAdminAuthorizationError('Forbidden', 403)
  }
  return { userId: session.userId, requestId: requestIdFrom(request), authenticatedAt: session.authenticatedAt }
}

export async function requirePlatformAdminPrincipal(request: Request): Promise<PlatformAdminPrincipal> {
  const { auth } = await import('./better-auth')
  const adminIds = parseAdminUserIds(process.env.ADMIN_USER_IDS)

  return resolvePlatformAdminPrincipal(request, {
    getSession: async (currentRequest) => {
      const result = await auth.api.getSession({ headers: currentRequest.headers })
      return result ? { userId: result.user.id, authenticatedAt: new Date(result.session.createdAt) } : null
    },
    isAdminUserId: (userId) => adminIds.size > 0 && adminIds.has(userId),
  })
}

/**
 * Guards a sensitive platform-admin mutation (pause/resume/manual-run, etc.) behind a recent
 * browser session — same convention and window as billing's `requireRecentBillingAuthentication`.
 * A no-op for a machine caller (no `authenticatedAt` at all, e.g. `tryCronPrincipal`): a
 * secret-bearing scheduler has no session to be stale, and is already strongly authenticated.
 */
export function requireRecentPlatformAdminAuthentication(principal: PlatformAdminPrincipal, now: Date = new Date()): void {
  if (!principal.authenticatedAt) return
  const ageSeconds = (now.getTime() - principal.authenticatedAt.getTime()) / 1000
  if (ageSeconds > RECENT_AUTH_MAX_AGE_SECONDS) {
    throw new PlatformAdminAuthorizationError('Recent re-authentication required', 401)
  }
}

/** Redacted audit trail for a platform-admin mutation. `organizationId` is null when the action has no single target organization (e.g. a global roadmap edit). */
export async function auditPlatformAdminAction(
  principal: PlatformAdminPrincipal,
  input: {
    action: string
    targetType: string
    targetId: string | null
    organizationId?: string | null
    result: 'allowed' | 'denied' | 'failed'
    details?: Record<string, unknown>
  },
): Promise<void> {
  await emitSecurityAudit(
    {
      organizationId: input.organizationId ?? null,
      actorUserId: principal.userId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      result: input.result,
      requestId: principal.requestId,
      details: input.details,
    },
    platformAdminAuditSink,
  )
}

export function platformAdminErrorResponse(error: unknown): Response | null {
  return error instanceof PlatformAdminAuthorizationError
    ? Response.json({ error: error.message }, { status: error.status })
    : null
}
