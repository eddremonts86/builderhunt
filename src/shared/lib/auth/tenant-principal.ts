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
  const [{ and, eq }, { auth }, { db }, { organizationMembers }] = await Promise.all([
    import('drizzle-orm'),
    import('./better-auth'),
    import('../db/index'),
    import('../db/schema'),
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
      const [membership] = await db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.organizationId, organizationId),
        ))
        .limit(1)
      return membership ?? null
    },
  })
}

function requestIdFrom(request: Request): string {
  const candidate = request.headers.get('x-request-id')
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : crypto.randomUUID()
}
