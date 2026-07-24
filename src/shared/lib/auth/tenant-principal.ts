import type { OrganizationRole, TenantPrincipal } from '../authorization/permissions'

interface SessionScope {
  userId: string
  activeOrganizationId: string | null
}

interface MembershipScope {
  role: string
}

export interface TenantPrincipalDependencies {
  getSession(request: Request): Promise<SessionScope | null>
  findMembership(userId: string, organizationId: string): Promise<MembershipScope | null>
  // Fired only for the genuine cross-tenant case (a session claims membership in an org it does
  // not belong to) — never for the "no active organization selected" case, which isn't a tenant
  // boundary breach. Awaited before throwing, but purely observational: it can never change
  // whether the request is rejected (abuse/anomalies.ts's cross-tenant-denial clustering).
  onMembershipDenied?(context: { userId: string; organizationId: string; requestId: string }): Promise<void> | void
}

export class TenantAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message)
    this.name = 'TenantAuthorizationError'
  }
}

const organizationRoles = new Set<OrganizationRole>(['owner', 'admin', 'member'])

export async function resolveTenantPrincipal(
  request: Request,
  dependencies: TenantPrincipalDependencies,
): Promise<TenantPrincipal> {
  const session = await dependencies.getSession(request)
  if (!session) throw new TenantAuthorizationError('Authentication required', 401)
  if (!session.activeOrganizationId) {
    throw new TenantAuthorizationError('An active organization is required', 403)
  }

  const membership = await dependencies.findMembership(session.userId, session.activeOrganizationId)
  if (!membership || !organizationRoles.has(membership.role as OrganizationRole)) {
    await dependencies.onMembershipDenied?.({
      userId: session.userId,
      organizationId: session.activeOrganizationId,
      requestId: requestIdFrom(request),
    })
    throw new TenantAuthorizationError('Active organization membership is invalid', 403)
  }

  return {
    userId: session.userId,
    organizationId: session.activeOrganizationId,
    role: membership.role as OrganizationRole,
    requestId: requestIdFrom(request),
  }
}

export async function requireTenantPrincipal(request: Request): Promise<TenantPrincipal> {
  const [{ and, eq }, { auth }, { authDb }, { organizationMembers }, { env }, { rateLimit }, { emitSecurityAudit }, { consoleSecurityAuditSink }, { checkCrossTenantDenialAndEmit }] = await Promise.all([
    import('drizzle-orm'),
    import('./better-auth'),
    import('../db/auth-db'),
    import('../db/schema'),
    import('../env'),
    import('../rate-limit'),
    import('../security/audit'),
    import('../security/audit-sink'),
    import('../abuse/anomalies'),
  ])

  return resolveTenantPrincipal(request, {
    getSession: async (currentRequest) => {
      const result = await auth.api.getSession({ headers: currentRequest.headers })
      if (!result) return null
      return {
        userId: result.user.id,
        activeOrganizationId: result.session.activeOrganizationId ?? null,
      }
    },
    findMembership: async (userId, organizationId) => {
      const [membership] = await authDb
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.organizationId, organizationId),
        ))
        .limit(1)
      return membership ?? null
    },
    onMembershipDenied: async ({ userId, organizationId, requestId }) => {
      await emitSecurityAudit({
        organizationId,
        actorUserId: userId,
        action: 'tenant.membership_check',
        targetType: 'organization',
        targetId: organizationId,
        result: 'denied',
        requestId,
      }, consoleSecurityAuditSink)
      await checkCrossTenantDenialAndEmit(
        { userId, organizationId, requestId },
        {
          gate: async (gateUserId) => {
            const result = await rateLimit(
              'cross-tenant-denied',
              gateUserId,
              env.ABUSE_CROSS_TENANT_DENIAL_THRESHOLD,
              env.ABUSE_CROSS_TENANT_DENIAL_WINDOW_MINUTES * 60,
            )
            return { allowed: result.allowed }
          },
        },
      )
    },
  })
}

function requestIdFrom(request: Request): string {
  const candidate = request.headers.get('x-request-id')
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : crypto.randomUUID()
}
