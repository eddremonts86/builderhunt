import { emitSecurityAudit } from '../security/audit'
import { consoleSecurityAuditSink } from '../security/audit-sink'

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
}

export interface PlatformAdminSessionScope {
  userId: string
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
  return { userId: session.userId, requestId: requestIdFrom(request) }
}

export async function requirePlatformAdminPrincipal(request: Request): Promise<PlatformAdminPrincipal> {
  const { auth } = await import('./better-auth')
  const adminIds = parseAdminUserIds(process.env.ADMIN_USER_IDS)

  return resolvePlatformAdminPrincipal(request, {
    getSession: async (currentRequest) => {
      const result = await auth.api.getSession({ headers: currentRequest.headers })
      return result ? { userId: result.user.id } : null
    },
    isAdminUserId: (userId) => adminIds.size > 0 && adminIds.has(userId),
  })
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
    consoleSecurityAuditSink,
  )
}

export function platformAdminErrorResponse(error: unknown): Response | null {
  return error instanceof PlatformAdminAuthorizationError
    ? Response.json({ error: error.message }, { status: error.status })
    : null
}
