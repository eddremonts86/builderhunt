import { emitSecurityAudit, type SecurityAuditSink } from '../security/audit'
import { consoleSecurityAuditSink } from '../security/audit-sink'
import { ORGANIZATION_MEMBERSHIP_LIMIT } from './organization-options'
import type { OrganizationRole, TenantPrincipal } from '../authorization/permissions'

/**
 * Wraps the better-auth organization plugin's operations with the
 * cross-cutting rules the plugin doesn't enforce on its own: centralized
 * per-user+organization rate limits, a recent-auth requirement before
 * owner/destructive changes, one generic error for every invitation-accept
 * failure mode (so a bad request can't be used to enumerate emails or
 * invitation state), and redacted audit events for every operation.
 *
 * Ownership transfer has no better-auth endpoint at all — `updateMemberRole`
 * would momentarily violate the one-owner-per-organization unique index if
 * the promote/demote happened in the wrong order within one statement, so
 * the real implementation runs them as two sequential UPDATEs in one
 * transaction (demote-then-promote), which never produces a transient
 * duplicate "owner" row.
 */

export const RECENT_AUTH_MAX_AGE_SECONDS = 15 * 60

const GENERIC_AUTH_ERROR = 'Authentication required'
const GENERIC_MEMBERSHIP_ERROR = 'You do not have access to this organization'
const GENERIC_INVITATION_ERROR = 'This invitation is no longer valid'
const GENERIC_STALE_SESSION_ERROR = 'Please sign in again to continue'

export class OrganizationLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
  ) {
    super(message)
    this.name = 'OrganizationLifecycleError'
  }
}

/** Thrown by `createInvitation` when the atomic seat check loses a race — never pre-computed by callers. */
export class SeatLimitExceededError extends Error {
  constructor() {
    super('Organization seat limit reached')
    this.name = 'SeatLimitExceededError'
  }
}

export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** A random suffix sidesteps `organizations.slug`'s unique constraint without a create-time collision retry loop — nothing today surfaces the slug to users, so a friendly one isn't worth the extra round trip. */
export function generateOrganizationSlug(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const suffix = crypto.randomUUID().slice(0, 8)
  return base ? `${base}-${suffix}` : `team-${suffix}`
}

export type InvitableRole = Exclude<OrganizationRole, 'owner'>

export interface LifecycleSession {
  userId: string
  sessionId: string
  email: string
  emailVerified: boolean
  activeOrganizationId: string | null
  authenticatedAt: Date
}

export interface MembershipRecord {
  organizationId: string
  userId: string
  role: OrganizationRole
}

export interface InvitationRecord {
  id: string
  organizationId: string
  organizationName: string
  email: string
  role: InvitableRole
  status: 'pending' | 'accepted' | 'rejected' | 'canceled'
  expiresAt: Date
  inviterId: string
}

export interface OrganizationRecord {
  id: string
  name: string
  slug: string
}

export interface LifecycleDependencies {
  getSession(request: Request): Promise<LifecycleSession | null>
  findMembership(userId: string, organizationId: string): Promise<MembershipRecord | null>
  countSeats(organizationId: string): Promise<number>
  membershipLimit: number
  createOrganization(input: { name: string; slug: string; ownerUserId: string }): Promise<OrganizationRecord>
  setActiveOrganization(session: LifecycleSession, organizationId: string | null): Promise<void>
  /** Throws `SeatLimitExceededError` when the atomic check fails — do not pre-check the limit here. */
  createInvitation(input: {
    organizationId: string
    organizationName: string
    email: string
    role: InvitableRole
    inviterId: string
  }): Promise<InvitationRecord>
  getInvitation(invitationId: string): Promise<InvitationRecord | null>
  cancelInvitationRecord(invitationId: string): Promise<void>
  acceptInvitationRecord(invitationId: string, userId: string): Promise<void>
  removeMemberRecord(organizationId: string, userId: string): Promise<void>
  updateMemberRoleRecord(organizationId: string, userId: string, role: InvitableRole): Promise<void>
  transferOwnershipRecord(organizationId: string, fromUserId: string, toUserId: string): Promise<void>
  deleteOrganizationRecord(organizationId: string): Promise<void>
  clearActiveOrganizationForUsers(organizationId: string, userIds: string[]): Promise<void>
  /** `devLink` is set only when no real email provider is configured (dev mode) — the invite/resend UI shows it as a manual-share fallback, since no email is actually going out. */
  sendInvitationEmail(email: string, organizationName: string, invitationId: string): Promise<{ devLink?: string }>
  rateLimit(scope: string, id: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean }>
  audit: SecurityAuditSink
  now(): Date
}

function requestIdFrom(request: Request): string {
  const candidate = request.headers.get('x-request-id')
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID()
}

async function requireSession(request: Request, deps: LifecycleDependencies): Promise<LifecycleSession> {
  const session = await deps.getSession(request)
  if (!session) throw new OrganizationLifecycleError(GENERIC_AUTH_ERROR, 401)
  return session
}

async function requireMembership(
  deps: LifecycleDependencies,
  userId: string,
  organizationId: string,
): Promise<MembershipRecord> {
  const membership = await deps.findMembership(userId, organizationId)
  if (!membership) throw new OrganizationLifecycleError(GENERIC_MEMBERSHIP_ERROR, 403)
  return membership
}

function requireElevated(membership: MembershipRecord): void {
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new OrganizationLifecycleError(GENERIC_MEMBERSHIP_ERROR, 403)
  }
}

function requireOwner(membership: MembershipRecord): void {
  if (membership.role !== 'owner') {
    throw new OrganizationLifecycleError(GENERIC_MEMBERSHIP_ERROR, 403)
  }
}

// Role changes, removal, ownership transfer, and deletion are irreversible or
// security-sensitive enough that a hijacked long-lived session shouldn't be
// able to perform them — require the session to have authenticated recently.
function requireRecentAuthentication(session: LifecycleSession, deps: LifecycleDependencies): void {
  const ageSeconds = (deps.now().getTime() - session.authenticatedAt.getTime()) / 1000
  if (ageSeconds > RECENT_AUTH_MAX_AGE_SECONDS) {
    throw new OrganizationLifecycleError(GENERIC_STALE_SESSION_ERROR, 401)
  }
}

async function requireRateLimit(
  deps: LifecycleDependencies,
  scope: string,
  id: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await deps.rateLimit(scope, id, limit, windowSeconds)
  if (!result.allowed) {
    throw new OrganizationLifecycleError('Too many requests, please try again later', 429)
  }
}

async function audit(
  deps: LifecycleDependencies,
  input: {
    organizationId: string | null
    actorUserId: string | null
    action: string
    targetType: string
    targetId: string | null
    result: 'allowed' | 'denied' | 'failed'
    requestId: string
  },
): Promise<void> {
  await emitSecurityAudit(input, deps.audit)
}

export function createOrganizationLifecycle(deps: LifecycleDependencies) {
  async function createOrganization(request: Request, input: { name: string; slug: string }): Promise<OrganizationRecord> {
    const session = await requireSession(request, deps)
    await requireRateLimit(deps, 'org-create', session.userId, 5, 60 * 60)

    const organization = await deps.createOrganization({
      name: input.name,
      slug: input.slug,
      ownerUserId: session.userId,
    })
    await audit(deps, {
      organizationId: organization.id,
      actorUserId: session.userId,
      action: 'organization.create',
      targetType: 'organization',
      targetId: organization.id,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
    return organization
  }

  async function switchActiveOrganization(request: Request, organizationId: string): Promise<void> {
    const session = await requireSession(request, deps)
    await requireMembership(deps, session.userId, organizationId)
    await deps.setActiveOrganization(session, organizationId)
    await audit(deps, {
      organizationId,
      actorUserId: session.userId,
      action: 'organization.switch',
      targetType: 'organization',
      targetId: organizationId,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
  }

  async function inviteMember(
    request: Request,
    input: { organizationId: string; email: string; role: InvitableRole },
  ): Promise<InvitationRecord & { devLink?: string }> {
    const session = await requireSession(request, deps)
    const membership = await requireMembership(deps, session.userId, input.organizationId)
    requireElevated(membership)
    await requireRateLimit(deps, 'org-invite', `${session.userId}:${input.organizationId}`, 20, 60 * 60)

    const email = normalizeInvitationEmail(input.email)
    let invitation: InvitationRecord
    try {
      invitation = await deps.createInvitation({
        organizationId: input.organizationId,
        organizationName: '',
        email,
        role: input.role,
        inviterId: session.userId,
      })
    } catch (error) {
      if (error instanceof SeatLimitExceededError) {
        await audit(deps, {
          organizationId: input.organizationId,
          actorUserId: session.userId,
          action: 'organization.invite',
          targetType: 'invitation',
          targetId: null,
          result: 'denied',
          requestId: requestIdFrom(request),
        })
        throw new OrganizationLifecycleError('This organization has reached its member limit', 409)
      }
      throw error
    }

    const { devLink } = await deps.sendInvitationEmail(invitation.email, invitation.organizationName, invitation.id)
    await audit(deps, {
      organizationId: input.organizationId,
      actorUserId: session.userId,
      action: 'organization.invite',
      targetType: 'invitation',
      targetId: invitation.id,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
    return { ...invitation, devLink }
  }

  async function resendInvitation(request: Request, invitationId: string): Promise<InvitationRecord & { devLink?: string }> {
    const session = await requireSession(request, deps)
    const invitation = await deps.getInvitation(invitationId)
    if (!invitation) throw new OrganizationLifecycleError('Invitation not found', 404)
    const membership = await requireMembership(deps, session.userId, invitation.organizationId)
    requireElevated(membership)
    await requireRateLimit(deps, 'org-invite', `${session.userId}:${invitation.organizationId}`, 20, 60 * 60)

    if (invitation.status !== 'pending') {
      throw new OrganizationLifecycleError('This invitation can no longer be resent', 409)
    }

    await deps.cancelInvitationRecord(invitation.id)
    let fresh: InvitationRecord
    try {
      fresh = await deps.createInvitation({
        organizationId: invitation.organizationId,
        organizationName: invitation.organizationName,
        email: invitation.email,
        role: invitation.role,
        inviterId: session.userId,
      })
    } catch (error) {
      if (error instanceof SeatLimitExceededError) {
        await audit(deps, {
          organizationId: invitation.organizationId,
          actorUserId: session.userId,
          action: 'organization.invite.resend',
          targetType: 'invitation',
          targetId: invitation.id,
          result: 'denied',
          requestId: requestIdFrom(request),
        })
        throw new OrganizationLifecycleError('This organization has reached its member limit', 409)
      }
      throw error
    }
    const { devLink } = await deps.sendInvitationEmail(fresh.email, fresh.organizationName, fresh.id)
    await audit(deps, {
      organizationId: invitation.organizationId,
      actorUserId: session.userId,
      action: 'organization.invite.resend',
      targetType: 'invitation',
      targetId: fresh.id,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
    return { ...fresh, devLink }
  }

  async function cancelInvitation(request: Request, invitationId: string): Promise<void> {
    const session = await requireSession(request, deps)
    const invitation = await deps.getInvitation(invitationId)
    if (!invitation) throw new OrganizationLifecycleError('Invitation not found', 404)
    const membership = await requireMembership(deps, session.userId, invitation.organizationId)
    requireElevated(membership)

    await deps.cancelInvitationRecord(invitation.id)
    await audit(deps, {
      organizationId: invitation.organizationId,
      actorUserId: session.userId,
      action: 'organization.invite.cancel',
      targetType: 'invitation',
      targetId: invitation.id,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
  }

  // Every failure path here — missing, wrong email, unverified email, expired,
  // already accepted/rejected/canceled — returns the exact same error and
  // status so a caller can't use this endpoint to probe invitation state or
  // harvest the invited email address.
  async function acceptInvitation(request: Request, invitationId: string): Promise<{ organizationId: string }> {
    const session = await requireSession(request, deps)
    await requireRateLimit(deps, 'org-invite-accept', session.userId, 20, 60 * 60)

    const invitation = await deps.getInvitation(invitationId)
    const isValid =
      invitation !== null &&
      invitation.status === 'pending' &&
      invitation.expiresAt.getTime() > deps.now().getTime() &&
      session.emailVerified &&
      normalizeInvitationEmail(session.email) === normalizeInvitationEmail(invitation.email)

    if (!invitation || !isValid) {
      await audit(deps, {
        organizationId: invitation?.organizationId ?? null,
        actorUserId: session.userId,
        action: 'organization.invite.accept',
        targetType: 'invitation',
        targetId: invitationId,
        result: 'denied',
        requestId: requestIdFrom(request),
      })
      throw new OrganizationLifecycleError(GENERIC_INVITATION_ERROR, 403)
    }

    await deps.acceptInvitationRecord(invitation.id, session.userId)
    await audit(deps, {
      organizationId: invitation.organizationId,
      actorUserId: session.userId,
      action: 'organization.invite.accept',
      targetType: 'invitation',
      targetId: invitation.id,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
    return { organizationId: invitation.organizationId }
  }

  async function removeMember(request: Request, organizationId: string, targetUserId: string): Promise<void> {
    const session = await requireSession(request, deps)
    const membership = await requireMembership(deps, session.userId, organizationId)
    // Any member may remove themselves (leave) without elevation — only
    // removing someone ELSE requires being an owner/admin.
    if (targetUserId !== session.userId) {
      requireElevated(membership)
    }
    requireRecentAuthentication(session, deps)

    const target = await deps.findMembership(targetUserId, organizationId)
    if (!target) throw new OrganizationLifecycleError('Member not found', 404)
    if (target.role === 'owner') {
      throw new OrganizationLifecycleError('Transfer ownership before removing the owner', 409)
    }
    // Only the owner may remove an admin; admins may remove members (and themselves).
    if (membership.role === 'admin' && target.role === 'admin' && targetUserId !== session.userId) {
      throw new OrganizationLifecycleError(GENERIC_MEMBERSHIP_ERROR, 403)
    }

    await deps.removeMemberRecord(organizationId, targetUserId)
    await deps.clearActiveOrganizationForUsers(organizationId, [targetUserId])
    await audit(deps, {
      organizationId,
      actorUserId: session.userId,
      action: 'organization.member.remove',
      targetType: 'member',
      targetId: targetUserId,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
  }

  // Role changes are owner-only: an admin cannot promote a member to admin or
  // touch another admin's role, which is what would let a member escalate
  // themselves via a compromised or over-trusted admin account.
  async function changeMemberRole(
    request: Request,
    organizationId: string,
    targetUserId: string,
    role: InvitableRole,
  ): Promise<void> {
    const session = await requireSession(request, deps)
    const membership = await requireMembership(deps, session.userId, organizationId)
    requireOwner(membership)
    requireRecentAuthentication(session, deps)

    const target = await deps.findMembership(targetUserId, organizationId)
    if (!target) throw new OrganizationLifecycleError('Member not found', 404)
    if (target.role === 'owner') {
      throw new OrganizationLifecycleError('Transfer ownership to change the owner', 409)
    }

    await deps.updateMemberRoleRecord(organizationId, targetUserId, role)
    await audit(deps, {
      organizationId,
      actorUserId: session.userId,
      action: 'organization.member.role-change',
      targetType: 'member',
      targetId: targetUserId,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
  }

  async function transferOwnership(request: Request, organizationId: string, targetUserId: string): Promise<void> {
    const session = await requireSession(request, deps)
    const membership = await requireMembership(deps, session.userId, organizationId)
    requireOwner(membership)
    requireRecentAuthentication(session, deps)

    const target = await deps.findMembership(targetUserId, organizationId)
    if (!target) throw new OrganizationLifecycleError('Member not found', 404)
    if (target.userId === session.userId) {
      throw new OrganizationLifecycleError('You already own this organization', 409)
    }

    await deps.transferOwnershipRecord(organizationId, session.userId, targetUserId)
    await audit(deps, {
      organizationId,
      actorUserId: session.userId,
      action: 'organization.ownership-transfer',
      targetType: 'member',
      targetId: targetUserId,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
  }

  async function deleteOrganization(request: Request, organizationId: string): Promise<void> {
    const session = await requireSession(request, deps)
    const membership = await requireMembership(deps, session.userId, organizationId)
    requireOwner(membership)
    requireRecentAuthentication(session, deps)

    // No explicit session cleanup needed: authSessions.activeOrganizationId
    // has ON DELETE SET NULL against organizations, so every member's stale
    // active-org reference clears automatically when the row is gone.
    await deps.deleteOrganizationRecord(organizationId)
    await audit(deps, {
      organizationId,
      actorUserId: session.userId,
      action: 'organization.delete',
      targetType: 'organization',
      targetId: organizationId,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
  }

  return {
    createOrganization,
    switchActiveOrganization,
    inviteMember,
    resendInvitation,
    cancelInvitation,
    acceptInvitation,
    removeMember,
    changeMemberRole,
    transferOwnership,
    deleteOrganization,
  }
}

export type OrganizationLifecycle = ReturnType<typeof createOrganizationLifecycle>

let cached: OrganizationLifecycle | null = null

/** Lazily builds the real, database-backed lifecycle — mirrors `requireTenantPrincipal`'s dynamic-import pattern so pure unit tests never touch the DB module graph. */
export async function getOrganizationLifecycle(): Promise<OrganizationLifecycle> {
  if (cached) return cached

  const [
    { and, eq, sql, count, inArray },
    { auth },
    { authDb },
    schema,
    { rateLimit },
    { sendOrganizationInvitationEmail },
    { env },
    { withTenantContext },
    { getOrganizationEntitlement },
  ] = await Promise.all([
    import('drizzle-orm'),
    import('./better-auth'),
    import('../db/auth-db'),
    import('../db/schema'),
    import('../rate-limit'),
    import('../email'),
    import('../env'),
    import('../db/tenant-context'),
    import('../repositories/entitlements'),
  ])
  const { organizations, organizationMembers, organizationInvitations, authSessions } = schema

  function toRole(role: string): OrganizationRole {
    return role as OrganizationRole
  }

  const realDependencies: LifecycleDependencies = {
    async getSession(request) {
      const result = await auth.api.getSession({ headers: request.headers })
      if (!result) return null
      return {
        userId: result.user.id,
        sessionId: result.session.id,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
        activeOrganizationId: result.session.activeOrganizationId ?? null,
        authenticatedAt: new Date(result.session.createdAt),
      }
    },

    async findMembership(userId, organizationId) {
      const [row] = await authDb
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, organizationId)))
        .limit(1)
      return row ? { organizationId, userId, role: toRole(row.role) } : null
    },

    async countSeats(organizationId) {
      const [members] = await authDb
        .select({ value: count() })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, organizationId))
      const [pendingInvitations] = await authDb
        .select({ value: count() })
        .from(organizationInvitations)
        .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.status, 'pending')))
      return (members?.value ?? 0) + (pendingInvitations?.value ?? 0)
    },

    membershipLimit: ORGANIZATION_MEMBERSHIP_LIMIT,

    async createOrganization(input) {
      const organizationId = crypto.randomUUID()
      await authDb.transaction(async (tx) => {
        await tx.insert(organizations).values({ id: organizationId, name: input.name, slug: input.slug })
        await tx.insert(organizationMembers).values({
          id: crypto.randomUUID(),
          organizationId,
          userId: input.ownerUserId,
          role: 'owner',
        })
      })
      return { id: organizationId, name: input.name, slug: input.slug }
    },

    async setActiveOrganization(session, organizationId) {
      await authDb
        .update(authSessions)
        .set({ activeOrganizationId: organizationId })
        .where(eq(authSessions.id, session.sessionId))
    },

    async createInvitation(input) {
      const id = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 60 * 60 * 24 * 7 * 1000)

      // The real per-organization seat allowance lives in
      // `organization_entitlements` — a tenant-private, RLS-forced table only
      // `builderhunt_app` can read (via `withTenantContext`), not this
      // function's `authDb`/`builderhunt_auth` connection. Read outside the
      // lock below: entitlement changes (admin plan grants) are rare enough
      // that a tiny staleness window here is an acceptable tradeoff against
      // spanning two different database roles in one atomic transaction.
      // `role` doesn't affect this read — the entitlement SELECT policy is
      // keyed only on `app.organization_id`.
      const entitlement = await withTenantContext(
        { userId: input.inviterId, organizationId: input.organizationId, role: 'member', requestId: crypto.randomUUID() },
        (tx) => getOrganizationEntitlement(tx, input.organizationId),
      )

      // Locks the organization's member rows for the rest of this transaction
      // so a concurrent invite can't read the same seat count before either
      // insert commits — the loser blocks here, then re-reads a count that
      // already includes the winner's row and throws instead of overselling
      // the seat.
      const organization = await authDb.transaction(async (tx) => {
        await tx.execute(sql`select 1 from organization_members where organization_id = ${input.organizationId} for update`)
        const [members] = await tx
          .select({ value: count() })
          .from(organizationMembers)
          .where(eq(organizationMembers.organizationId, input.organizationId))
        const [pendingInvitations] = await tx
          .select({ value: count() })
          .from(organizationInvitations)
          .where(and(eq(organizationInvitations.organizationId, input.organizationId), eq(organizationInvitations.status, 'pending')))
        const seats = (members?.value ?? 0) + (pendingInvitations?.value ?? 0)
        if (seats >= entitlement.seatLimit) throw new SeatLimitExceededError()

        await tx.insert(organizationInvitations).values({
          id,
          organizationId: input.organizationId,
          email: input.email,
          role: input.role,
          status: 'pending',
          expiresAt,
          inviterId: input.inviterId,
        })

        const [row] = await tx
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, input.organizationId))
          .limit(1)
        return row
      })

      return {
        id,
        organizationId: input.organizationId,
        organizationName: organization?.name ?? input.organizationName,
        email: input.email,
        role: input.role,
        status: 'pending',
        expiresAt,
        inviterId: input.inviterId,
      }
    },

    async getInvitation(invitationId) {
      const [row] = await authDb
        .select({
          id: organizationInvitations.id,
          organizationId: organizationInvitations.organizationId,
          organizationName: organizations.name,
          email: organizationInvitations.email,
          role: organizationInvitations.role,
          status: organizationInvitations.status,
          expiresAt: organizationInvitations.expiresAt,
          inviterId: organizationInvitations.inviterId,
        })
        .from(organizationInvitations)
        .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
        .where(eq(organizationInvitations.id, invitationId))
        .limit(1)
      if (!row) return null
      return {
        id: row.id,
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        email: row.email,
        role: (row.role ?? 'member') as InvitableRole,
        status: row.status as InvitationRecord['status'],
        expiresAt: row.expiresAt,
        inviterId: row.inviterId,
      }
    },

    async cancelInvitationRecord(invitationId) {
      await authDb
        .update(organizationInvitations)
        .set({ status: 'canceled' })
        .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.status, 'pending')))
    },

    async acceptInvitationRecord(invitationId, userId) {
      await authDb.transaction(async (tx) => {
        const [invitation] = await tx
          .update(organizationInvitations)
          .set({ status: 'accepted' })
          .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.status, 'pending')))
          .returning({ organizationId: organizationInvitations.organizationId, role: organizationInvitations.role })
        if (!invitation) return
        await tx
          .insert(organizationMembers)
          .values({
            id: crypto.randomUUID(),
            organizationId: invitation.organizationId,
            userId,
            role: invitation.role ?? 'member',
          })
          .onConflictDoNothing()
      })
    },

    async removeMemberRecord(organizationId, userId) {
      await authDb
        .delete(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    },

    async updateMemberRoleRecord(organizationId, userId, role) {
      await authDb
        .update(organizationMembers)
        .set({ role })
        .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    },

    // Two sequential UPDATEs in one transaction: demoting the current owner
    // first removes the old "owner" index entry before the new one is
    // inserted, so the partial unique index on (organization_id) WHERE
    // role = 'owner' never sees two owners at once.
    async transferOwnershipRecord(organizationId, fromUserId, toUserId) {
      await authDb.transaction(async (tx) => {
        await tx
          .update(organizationMembers)
          .set({ role: 'admin' })
          .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, fromUserId)))
        await tx
          .update(organizationMembers)
          .set({ role: 'owner' })
          .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, toUserId)))
      })
    },

    async deleteOrganizationRecord(organizationId) {
      await authDb.delete(organizations).where(eq(organizations.id, organizationId))
    },

    async clearActiveOrganizationForUsers(organizationId, userIds) {
      if (userIds.length === 0) return
      // `sql`...= any(${userIds})`` looks right but the postgres.js driver
      // can't serialize a plain JS array through a raw template interpolation
      // this way — it sends a malformed array literal and every call fails.
      // `inArray` handles the parameterization correctly.
      await authDb
        .update(authSessions)
        .set({ activeOrganizationId: null })
        .where(and(eq(authSessions.activeOrganizationId, organizationId), inArray(authSessions.userId, userIds)))
    },

    async sendInvitationEmail(email, organizationName, invitationId) {
      const invitationUrl = new URL(`/team/invite/${encodeURIComponent(invitationId)}`, env.APP_URL).toString()
      const result = await sendOrganizationInvitationEmail(email, organizationName, invitationUrl)
      if (!result.ok) throw new Error('Unable to deliver organization invitation')
      return { devLink: result.devLink }
    },

    async rateLimit(scope, id, limit, windowSeconds) {
      return rateLimit(scope, id, limit, windowSeconds)
    },

    audit: consoleSecurityAuditSink,

    now() {
      return new Date()
    },
  }

  cached = createOrganizationLifecycle(realDependencies)
  return cached
}

export interface MyOrganizationRecord {
  organization: OrganizationRecord
  role: OrganizationRole
  isPersonal: boolean
}

/**
 * "Which organizations am I in, and what's my role in each" — the read the
 * Team-account switcher/settings surfaces need. Reads via authDb: like
 * account-privacy.ts's `memberships` query, `organization_members`/
 * `organizations` are RLS-forced by `organization_id`, and this is exactly
 * the query that discovers those ids in the first place, so it can't be
 * scoped to any single one. authDb already carries an unrestricted
 * auth-broker policy on both tables (better-auth needs it to list
 * switchable orgs) — no chicken-and-egg tenant-context problem.
 */
export async function listMyOrganizations(userId: string): Promise<MyOrganizationRecord[]> {
  const [{ eq }, { authDb }, schema] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
  ])
  const { organizations, organizationMembers } = schema

  const rows = await authDb
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      metadata: organizations.metadata,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId))

  return rows.map((row) => ({
    organization: { id: row.id, name: row.name, slug: row.slug },
    role: row.role as OrganizationRole,
    isPersonal: isPersonalOrganizationMetadata(row.metadata),
  }))
}

function isPersonalOrganizationMetadata(metadata: string | null): boolean {
  if (!metadata) return false
  try {
    const parsed = JSON.parse(metadata) as { kind?: string }
    return parsed?.kind === 'personal'
  } catch {
    return false
  }
}

export interface OrganizationMemberRecord {
  userId: string
  name: string
  email: string
  role: OrganizationRole
  joinedAt: Date
}

/** Team settings' member list — same authDb rationale as `listMyOrganizations`: RLS-forced tables this read discovers the scope for. */
export async function listOrganizationMembers(organizationId: string): Promise<OrganizationMemberRecord[]> {
  const [{ eq }, { authDb }, schema] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
  ])
  const { organizationMembers, authUsers } = schema

  const rows = await authDb
    .select({
      userId: organizationMembers.userId,
      name: authUsers.name,
      email: authUsers.email,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(authUsers, eq(authUsers.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId))

  return rows.map((row) => ({ ...row, role: row.role as OrganizationRole }))
}

/** Pending invitations only — accepted/rejected/canceled ones aren't actionable from Team settings. */
export async function listPendingInvitations(organizationId: string): Promise<InvitationRecord[]> {
  const [{ and, eq }, { authDb }, schema] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
  ])
  const { organizationInvitations, organizations } = schema

  const rows = await authDb
    .select({
      id: organizationInvitations.id,
      organizationId: organizationInvitations.organizationId,
      organizationName: organizations.name,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      status: organizationInvitations.status,
      expiresAt: organizationInvitations.expiresAt,
      inviterId: organizationInvitations.inviterId,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.status, 'pending')))

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    email: row.email,
    role: (row.role ?? 'member') as InvitableRole,
    status: row.status as InvitationRecord['status'],
    expiresAt: row.expiresAt,
    inviterId: row.inviterId,
  }))
}

/**
 * "Am I invited anywhere?" — invitations are keyed by email, not user id (the
 * invitee may not have an account yet when the invite is sent), so this is
 * the only way a signed-in user's own pending invitations can ever surface
 * without them having the original email/link in hand. Only ever call this
 * with the CALLER'S OWN verified session email — never an arbitrary email a
 * client could supply, or any authenticated user could enumerate who else
 * has been invited where.
 */
export async function listInvitationsForEmail(email: string): Promise<InvitationRecord[]> {
  const [{ and, eq }, { authDb }, schema] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
  ])
  const { organizationInvitations, organizations } = schema
  const normalized = normalizeInvitationEmail(email)

  const rows = await authDb
    .select({
      id: organizationInvitations.id,
      organizationId: organizationInvitations.organizationId,
      organizationName: organizations.name,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      status: organizationInvitations.status,
      expiresAt: organizationInvitations.expiresAt,
      inviterId: organizationInvitations.inviterId,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(and(eq(organizationInvitations.email, normalized), eq(organizationInvitations.status, 'pending')))

  const now = Date.now()
  return rows
    .map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      email: row.email,
      role: (row.role ?? 'member') as InvitableRole,
      status: row.status as InvitationRecord['status'],
      expiresAt: row.expiresAt,
      inviterId: row.inviterId,
    }))
    .filter((invitation) => invitation.expiresAt.getTime() > now)
}

export interface SeatUsageRecord {
  used: number
  limit: number
}

/** Accepted members plus usable (pending) invitations — mirrors the real dependency's `countSeats` used to enforce the atomic invite-time limit. */
/**
 * Takes the full `TenantPrincipal` (not just an id) because the real seat
 * *limit* — unlike the member/invitation counts — doesn't live in an
 * auth-broker table at all: `organization_entitlements` is a tenant-private,
 * RLS-forced table only `builderhunt_app` can read, gated on
 * `app.organization_id` via `withTenantContext`. Using the hardcoded
 * `ORGANIZATION_MEMBERSHIP_LIMIT` here (as this function used to) silently
 * ignored a real, paid/admin-granted per-organization entitlement.
 */
export async function getSeatUsage(principal: TenantPrincipal): Promise<SeatUsageRecord> {
  const [{ and, eq, count }, { authDb }, schema, { withTenantContext }, { getOrganizationEntitlement }] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
    import('../db/tenant-context'),
    import('../repositories/entitlements'),
  ])
  const { organizationMembers, organizationInvitations } = schema

  const [members] = await authDb
    .select({ value: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, principal.organizationId))
  const [pendingInvitations] = await authDb
    .select({ value: count() })
    .from(organizationInvitations)
    .where(and(eq(organizationInvitations.organizationId, principal.organizationId), eq(organizationInvitations.status, 'pending')))
  const entitlement = await withTenantContext(principal, (tx) => getOrganizationEntitlement(tx, principal.organizationId))

  return {
    used: (members?.value ?? 0) + (pendingInvitations?.value ?? 0),
    limit: entitlement.seatLimit,
  }
}
