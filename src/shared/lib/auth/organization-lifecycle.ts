import { emitSecurityAudit, type SecurityAuditSink } from '../security/audit'
import { createDatabaseSecurityAuditSink } from '../security/audit-sink'
import { ORGANIZATION_MEMBERSHIP_LIMIT } from './organization-options'
import type { OrganizationRole, TenantPrincipal } from '../authorization/permissions'
import type { PlanStatus } from '../billing-shared'
import type { EntitlementTier } from '../repositories/entitlements'
import type { KeysetTransaction } from '../table/keyset'
import type { PageRequest, PageResult, TableQuery } from '../table/types'

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

// Matches the account-deletion grace period (legal.ts's GRACE_PERIOD_MS) for
// consistent messaging — organization deletion does not reuse that table or
// worker, but there's no reason its own policy window should differ.
export const ORGANIZATION_DELETION_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000

const GENERIC_AUTH_ERROR = 'Authentication required'
const GENERIC_MEMBERSHIP_ERROR = 'You do not have access to this organization'
const GENERIC_INVITATION_ERROR = 'This invitation is no longer valid'
/** Exported so client UI can special-case this exact message with a "sign in again" CTA instead of a generic error banner — see OrganizationDangerZone.tsx. */
export const STALE_SESSION_ERROR_MESSAGE = 'Please sign in again to continue'
const GENERIC_STALE_SESSION_ERROR = STALE_SESSION_ERROR_MESSAGE

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

export interface OrganizationDeletionRecord {
  id: string
  status: 'pending' | 'completed' | 'cancelled'
  gracePeriodEndsAt: Date
  requestedByUserId: string
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
  /**
   * The pending invitation for (organization, email), if one exists.
   *
   * Only consulted after `organization_invitations_one_pending_unique` rejects a concurrent insert, to return the
   * winner instead of a 500. Optional so the many existing fake-deps unit tests keep compiling — same reason
   * `onMembershipDenied` is optional on `TenantPrincipalDependencies`.
   */
  findPendingInvitation?(organizationId: string, email: string): Promise<InvitationRecord | null>
  cancelInvitationRecord(invitationId: string): Promise<void>
  acceptInvitationRecord(invitationId: string, userId: string): Promise<void>
  removeMemberRecord(organizationId: string, userId: string): Promise<void>
  updateMemberRoleRecord(organizationId: string, userId: string, role: InvitableRole): Promise<void>
  transferOwnershipRecord(organizationId: string, fromUserId: string, toUserId: string): Promise<void>
  /** Upserts on `organizationId` (unique) so re-requesting after a cancel reuses the same row instead of erroring on a unique violation. */
  requestOrganizationDeletionRecord(organizationId: string, requestedByUserId: string, gracePeriodEndsAt: Date): Promise<{ id: string }>
  cancelOrganizationDeletionRecord(organizationId: string): Promise<{ id: string } | null>
  clearActiveOrganizationForUsers(organizationId: string, userIds: string[]): Promise<void>
  /** `devLink` is set only when no real email provider is configured (dev mode) — the invite/resend UI shows it as a manual-share fallback, since no email is actually going out. */
  sendInvitationEmail(email: string, organizationName: string, invitationId: string): Promise<{ devLink?: string }>
  rateLimit(scope: string, id: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean }>
  audit: SecurityAuditSink
  now(): Date
}

/**
 * Whether a failed insert is the pending-invitation unique violation rather than any other error.
 *
 * Matched on SQLSTATE `23505` plus the constraint name, so a different unique violation on the same table — or a
 * future one — is still surfaced rather than silently treated as "someone else already invited them". The driver
 * sometimes nests the real error under `cause`, so both are inspected; the same shape
 * `repositories/status-subscribers.ts` already handles.
 */
function isPendingInvitationConflict(error: unknown): boolean {
  const candidates: unknown[] = [error]
  if (error && typeof error === 'object' && 'cause' in error) candidates.push((error as { cause: unknown }).cause)
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const code = (candidate as { code?: unknown }).code
    const constraint = (candidate as { constraint_name?: unknown; constraint?: unknown })
    const name = typeof constraint.constraint_name === 'string'
      ? constraint.constraint_name
      : typeof constraint.constraint === 'string' ? constraint.constraint : ''
    if (code === '23505' && name === 'organization_invitations_one_pending_unique') return true
    if (candidate instanceof Error && /organization_invitations_one_pending_unique/.test(candidate.message)) return true
  }
  return false
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

/**
 * Membership, but a non-member is told the resource does not exist.
 *
 * For anything addressed by an id a stranger could guess, "403 you are not a member" and "404 no such thing"
 * must be the same answer. Otherwise the pair is an enumeration oracle: sweep the id space, and every 403
 * confirms a real record. For invitations that is not abstract — a real invitation id says an organization is
 * hiring, that someone is mid-onboarding, and it is the id an acceptance link carries.
 *
 * A *member* who lacks the role still gets 403 from `requireElevated`, and should: they can already see the
 * invitation in their own organization's list, so the status code tells them nothing new.
 *
 * Found by `tests/e2e/api/organizations-invitations.spec.ts`, which probes a real foreign id and a fabricated
 * one and requires the two answers to be indistinguishable.
 */
async function requireMembershipOrNotFound(
  deps: LifecycleDependencies,
  userId: string,
  organizationId: string,
  notFoundMessage: string,
): Promise<MembershipRecord> {
  const membership = await deps.findMembership(userId, organizationId)
  if (!membership) throw new OrganizationLifecycleError(notFoundMessage, 404)
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
    /** Redacted by `emitSecurityAudit` before it reaches any sink — safe for small, non-PII context. */
    details?: Record<string, unknown>
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
      /**
       * A concurrent invite to the same address lost the race against
       * `organization_invitations_one_pending_unique`. The index is what makes duplicates impossible; this is what
       * makes losing graceful — the caller asked for "this person is invited", and that is now true, so returning
       * the winner's invitation is the honest answer rather than a 500 for an outcome that succeeded.
       *
       * Deliberately **no second email**: the winning request already sent one, and the whole point of the index is
       * that the invitee receives one working link instead of four, at most one of which still resolves.
       */
      if (isPendingInvitationConflict(error)) {
        const existing = await deps.findPendingInvitation?.(input.organizationId, email)
        if (existing) {
          await audit(deps, {
            organizationId: input.organizationId,
            actorUserId: session.userId,
            action: 'organization.invite',
            targetType: 'invitation',
            targetId: existing.id,
            result: 'allowed',
            requestId: requestIdFrom(request),
            details: { deduplicated: true },
          })
          return existing
        }
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
    const membership = await requireMembershipOrNotFound(
      deps,
      session.userId,
      invitation.organizationId,
      'Invitation not found',
    )
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
    const membership = await requireMembershipOrNotFound(
      deps,
      session.userId,
      invitation.organizationId,
      'Invitation not found',
    )
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

  async function transferOwnership(
    request: Request,
    organizationId: string,
    targetUserId: string,
  ): Promise<{ requestId: string }> {
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
    const requestId = requestIdFrom(request)
    await audit(deps, {
      organizationId,
      actorUserId: session.userId,
      action: 'organization.ownership-transfer',
      targetType: 'member',
      targetId: targetUserId,
      result: 'allowed',
      requestId,
    })
    return { requestId }
  }

  /**
   * Schedules the organization for deletion after a grace period rather than
   * deleting it immediately — mirrors the account-deletion UX (legal.ts) but
   * deliberately doesn't reuse its table/worker: an organization's deletion
   * affects every other member, not just the requester, so it gets its own
   * `organization_deletion_requests` row and its own worker sweep
   * (`processPendingOrganizationDeletions`). The actual hard delete only
   * ever happens there, once the grace period has passed.
   */
  async function requestOrganizationDeletion(
    request: Request,
    organizationId: string,
  ): Promise<{ id: string; gracePeriodEndsAt: Date }> {
    const session = await requireSession(request, deps)
    const membership = await requireMembership(deps, session.userId, organizationId)
    requireOwner(membership)
    requireRecentAuthentication(session, deps)

    const gracePeriodEndsAt = new Date(deps.now().getTime() + ORGANIZATION_DELETION_GRACE_PERIOD_MS)
    const result = await deps.requestOrganizationDeletionRecord(organizationId, session.userId, gracePeriodEndsAt)
    await audit(deps, {
      organizationId,
      actorUserId: session.userId,
      action: 'organization.delete.requested',
      targetType: 'organization',
      targetId: organizationId,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
    return { id: result.id, gracePeriodEndsAt }
  }

  /** Cancelling is the safe direction — no recent-auth challenge, same as the account-deletion cancel flow. */
  async function cancelOrganizationDeletion(request: Request, organizationId: string): Promise<{ id: string | null }> {
    const session = await requireSession(request, deps)
    const membership = await requireMembership(deps, session.userId, organizationId)
    requireOwner(membership)

    const cancelled = await deps.cancelOrganizationDeletionRecord(organizationId)
    await audit(deps, {
      organizationId,
      actorUserId: session.userId,
      action: 'organization.delete.cancelled',
      targetType: 'organization',
      targetId: organizationId,
      result: 'allowed',
      requestId: requestIdFrom(request),
    })
    return { id: cancelled?.id ?? null }
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
    requestOrganizationDeletion,
    cancelOrganizationDeletion,
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
  const { organizations, organizationMembers, organizationInvitations, organizationDeletionRequests, authSessions } = schema

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

    async requestOrganizationDeletionRecord(organizationId, requestedByUserId, gracePeriodEndsAt) {
      const [row] = await authDb
        .insert(organizationDeletionRequests)
        .values({ id: crypto.randomUUID(), organizationId, requestedByUserId, status: 'pending', gracePeriodEndsAt })
        .onConflictDoUpdate({
          target: organizationDeletionRequests.organizationId,
          set: { requestedByUserId, status: 'pending', gracePeriodEndsAt, completedAt: null },
        })
        .returning({ id: organizationDeletionRequests.id })
      return { id: row.id }
    },

    async cancelOrganizationDeletionRecord(organizationId) {
      const [row] = await authDb
        .update(organizationDeletionRequests)
        .set({ status: 'cancelled' })
        .where(and(eq(organizationDeletionRequests.organizationId, organizationId), eq(organizationDeletionRequests.status, 'pending')))
        .returning({ id: organizationDeletionRequests.id })
      return row ?? null
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

    /**
     * Only reached when `organization_invitations_one_pending_unique` rejected a concurrent insert, so this reads the
     * row that won the race. Same `authDb` connection as every other invitation read in this block.
     */
    async findPendingInvitation(organizationId, email) {
      const [row] = await authDb
        .select()
        .from(organizationInvitations)
        .where(and(
          eq(organizationInvitations.organizationId, organizationId),
          eq(organizationInvitations.email, email),
          eq(organizationInvitations.status, 'pending'),
        ))
        .limit(1)
      if (!row) return null
      return {
        id: row.id,
        organizationId: row.organizationId,
        organizationName: '',
        email: row.email,
        role: (row.role ?? 'member') as InvitableRole,
        // The query filters on it, so the literal is a fact rather than a cast that hides a wider type.
        status: 'pending' as const,
        expiresAt: row.expiresAt,
        inviterId: row.inviterId,
      }
    },

    /**
     * Durable now, not just logged. The insert is best-effort and never fails the caller — see
     * `createDatabaseSecurityAuditSink`. `authDb` is the connection every other write in this block already uses, and
     * the app role has INSERT and deliberately no SELECT on this table, so this must never use `.returning()`.
     */
    audit: createDatabaseSecurityAuditSink(async (event) => {
      await authDb.insert(schema.securityAuditEvents).values({
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
    }),

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

/**
 * Run one read on the auth-broker connection with a tenant setting the keyset builder can verify.
 *
 * `buildKeysetPage` refuses to build anything until it has read `app.organization_id` back out of
 * its own transaction — see `keyset.ts`, where the point is spelled out: a builder that took the
 * id from its caller and ran outside a tenant context would query with RLS's `current_setting`
 * empty, and that is a cross-tenant read with nothing to notice.
 *
 * The reads below cannot run inside `withTenantContext`, because `builderhunt_app` has no grant on
 * `organization_members`/`auth_users` after the auth broker split (drizzle/0007). So rather than
 * hand the builder an unverifiable id, this actually sets the thing it checks for — the same shape
 * as `withPlatformOrganization`, against `authDb`. If either table is ever given RLS, the policy
 * finds the value already there.
 */
async function withAuthBrokerOrganization<TResult>(
  organizationId: string,
  operation: (transaction: KeysetTransaction) => Promise<TResult>,
): Promise<TResult> {
  const [{ sql }, { authDb }] = await Promise.all([import('drizzle-orm'), import('../db/auth-db')])
  return authDb.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`)
    return operation(transaction as unknown as KeysetTransaction)
  })
}

/** One keyset page of the roster, each row carrying the name and email the grid shows. */
// unbounded-read-ok: the second select has no LIMIT because it does not need one — its `inArray`
// takes exactly the ids the keyset page just returned, so it is bounded by TABLE_PAGE_SIZE.
export async function pageOrganizationMembers(
  organizationId: string,
  query: TableQuery,
  page: PageRequest,
): Promise<PageResult<OrganizationMemberRecord>> {
  const [{ inArray }, { authDb }, schema, { buildKeysetPage }, { organizationMembersCapability }] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
    import('../table/keyset'),
    import('../table/capabilities/organization-members'),
  ])
  const { organizationMembers, authUsers } = schema

  const result = await withAuthBrokerOrganization(organizationId, (transaction) =>
    buildKeysetPage<{ userId: string; role: OrganizationRole; joinedAt: Date }>(
      transaction,
      organizationMembersCapability,
      query,
      page,
      {
        select: {
          userId: organizationMembers.userId,
          role: organizationMembers.role,
          joinedAt: organizationMembers.createdAt,
        },
        mapRow: (row) => ({
          userId: row.userId as string,
          role: row.role as OrganizationRole,
          joinedAt: row.joinedAt as Date,
        }),
      },
    ))

  // Names live on `auth_users`, one join away, and a capability describes one table. Resolved for
  // the rows this page returned rather than for the whole roster — the same page-then-enrich shape
  // as `pagePlatformUsersWithBilling`.
  if (result.rows.length === 0) return { ...result, rows: [] }
  const identities = await authDb
    .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(inArray(authUsers.id, result.rows.map((row) => row.userId)))
  const byId = new Map(identities.map((identity) => [identity.id, identity]))

  return {
    ...result,
    rows: result.rows.map((row) => ({
      userId: row.userId,
      // A membership whose user row vanished is a broken state, not a reason to drop the row from
      // a roster that still counts it against the seat limit.
      name: byId.get(row.userId)?.name ?? 'Unknown user',
      email: byId.get(row.userId)?.email ?? '',
      role: row.role,
      joinedAt: row.joinedAt,
    })),
  }
}

/**
 * Non-owner members the current owner could transfer ownership to, bounded.
 *
 * The danger zone's picker used to filter the whole roster in the browser. It is a `<select>`, not
 * a grid — it cannot page — so the bound is explicit and the caller is told when it bit, rather
 * than the list silently ending. An organization with more than this many transferable members is
 * not a case this control is designed for, and saying so is better than quietly offering the
 * first hundred as if they were all of them.
 */
export const TRANSFER_CANDIDATE_LIMIT = 100

export async function listOwnershipTransferCandidates(
  organizationId: string,
): Promise<{ candidates: OrganizationMemberRecord[]; truncated: boolean }> {
  const [{ and, eq, ne, asc }, { authDb }, schema] = await Promise.all([
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
    .where(and(
      eq(organizationMembers.organizationId, organizationId),
      ne(organizationMembers.role, 'owner'),
    ))
    .orderBy(asc(organizationMembers.createdAt), asc(organizationMembers.id))
    // One more than the limit, so "was there more" is an answer rather than a guess.
    .limit(TRANSFER_CANDIDATE_LIMIT + 1)

  const truncated = rows.length > TRANSFER_CANDIDATE_LIMIT
  return {
    candidates: (truncated ? rows.slice(0, TRANSFER_CANDIDATE_LIMIT) : rows)
      .map((row) => ({ ...row, role: row.role as OrganizationRole })),
    truncated,
  }
}

/**
 * Actor names for the activity feed (plans/UI/tasks.md Wave 2 "Make Team
 * Activity human and navigable") — same authDb rationale as
 * `listOrganizationMembers`: the tenant `organization_activity` repository
 * has no grant on `auth_users`/`organization_members` post auth-broker
 * (drizzle/0007_auth_broker.sql), so name resolution happens here instead.
 *
 * Deliberately scoped to *current* members of `organizationId` — this is
 * the allowlist. A user who has since left the organization resolves to
 * nothing (the caller renders "Former member"), never a name looked up
 * unconditionally by id, which would leak a name across organizations for
 * an id an attacker merely guessed at.
 */
export async function resolveActorDisplayNames(
  organizationId: string,
  actorUserIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = Array.from(new Set(actorUserIds))
  if (uniqueIds.length === 0) return new Map()
  const [{ and, eq, inArray }, { authDb }, schema] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
  ])
  const { organizationMembers, authUsers } = schema

  const rows = await authDb
    .select({ userId: organizationMembers.userId, name: authUsers.name })
    .from(organizationMembers)
    .innerJoin(authUsers, eq(authUsers.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, organizationId), inArray(organizationMembers.userId, uniqueIds)))

  return new Map(rows.map((row) => [row.userId, row.name]))
}

/**
 * One keyset page of pending invitations.
 *
 * `status = 'pending'` is the surface's own predicate rather than a filter dimension — see the
 * capability. The organization *name* is not selected per row: it is the same value on every row
 * of the page by construction, so the caller carries it once instead of sixty times over the wire.
 */
export async function pageOrganizationInvitations(
  organizationId: string,
  query: TableQuery,
  page: PageRequest,
): Promise<PageResult<Omit<InvitationRecord, 'organizationName'>>> {
  const [{ eq }, schema, { buildKeysetPage }, { organizationInvitationsCapability }] = await Promise.all([
    import('drizzle-orm'),
    import('../db/schema'),
    import('../table/keyset'),
    import('../table/capabilities/organization-invitations'),
  ])
  const { organizationInvitations } = schema

  return withAuthBrokerOrganization(organizationId, (transaction) =>
    buildKeysetPage<Omit<InvitationRecord, 'organizationName'>>(
      transaction,
      organizationInvitationsCapability,
      query,
      page,
      {
        scope: [eq(organizationInvitations.status, 'pending')],
        select: {
          id: organizationInvitations.id,
          organizationId: organizationInvitations.organizationId,
          email: organizationInvitations.email,
          role: organizationInvitations.role,
          status: organizationInvitations.status,
          expiresAt: organizationInvitations.expiresAt,
          inviterId: organizationInvitations.inviterId,
        },
        mapRow: (row) => ({
          id: row.id as string,
          organizationId: row.organizationId as string,
          email: row.email as string,
          role: ((row.role as string | null) ?? 'member') as InvitableRole,
          status: row.status as InvitationRecord['status'],
          expiresAt: row.expiresAt as Date,
          inviterId: row.inviterId as string,
        }),
      },
    ))
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

export interface OrganizationEntitlementRecord {
  tier: EntitlementTier
  status: PlanStatus
  billingPeriod: 'none' | 'monthly' | 'annual'
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
  notes: string | null
  seatLimit: number
  paidActionsAllowed: boolean
}

/**
 * The active organization's real billing entitlement — tenant-private,
 * RLS-forced table, so (unlike the membership/invitation reads above) this
 * goes through `withTenantContext`/`builderhunt_app`, not authDb. Mirrors
 * what `GET /api/plans/me` already read inline; centralized here so
 * Team-account billing UI composes it through contracts.ts instead of a
 * route importing `organization_entitlements` directly.
 */
export async function getOrganizationBillingDetail(principal: TenantPrincipal): Promise<OrganizationEntitlementRecord> {
  const [{ eq }, schema, { withTenantContext }, { getOrganizationEntitlement }] = await Promise.all([
    import('drizzle-orm'),
    import('../db/schema'),
    import('../db/tenant-context'),
    import('../repositories/entitlements'),
  ])
  const { organizationEntitlements } = schema

  return withTenantContext(principal, async (tx) => {
    const [policy, detailRows] = await Promise.all([
      getOrganizationEntitlement(tx, principal.organizationId),
      tx
        .select({
          billingPeriod: organizationEntitlements.billingPeriod,
          currentPeriodEnd: organizationEntitlements.currentPeriodEnd,
          trialEndsAt: organizationEntitlements.trialEndsAt,
          notes: organizationEntitlements.notes,
        })
        .from(organizationEntitlements)
        .where(eq(organizationEntitlements.organizationId, principal.organizationId))
        .limit(1),
    ])
    const detail = detailRows[0] ?? null
    return {
      tier: policy.tier,
      status: policy.status,
      billingPeriod: (detail?.billingPeriod ?? 'none') as 'none' | 'monthly' | 'annual',
      currentPeriodEnd: detail?.currentPeriodEnd ?? null,
      trialEndsAt: detail?.trialEndsAt ?? null,
      notes: detail?.notes ?? null,
      seatLimit: policy.seatLimit,
      paidActionsAllowed: policy.paidActionsAllowed,
    }
  })
}

/**
 * Race-safe guard against shrinking an organization below its current seat
 * usage — the downgrade mirror of `createInvitation`'s atomic seat check
 * above. Locks the same `organization_members` row set `for update` so a
 * concurrent invite can't slip a member in between this count and whatever
 * write the caller makes next; throws the same `SeatLimitExceededError` a
 * concurrent invite race would. No product mutation calls a lower tier yet
 * (no self-serve downgrade exists without Stripe), but the one real place a
 * tier shrinks today — an admin plan grant, `setPlatformUserPlan` — calls
 * this before writing the new (possibly smaller) seat limit.
 */
export async function assertSeatLimitDowngradeIsSafe(organizationId: string, targetSeatLimit: number): Promise<void> {
  const [{ and, eq, count, sql }, { authDb }, schema] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
  ])
  const { organizationMembers, organizationInvitations } = schema

  await authDb.transaction(async (tx) => {
    await tx.execute(sql`select 1 from organization_members where organization_id = ${organizationId} for update`)
    const [members] = await tx
      .select({ value: count() })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId))
    const [pendingInvitations] = await tx
      .select({ value: count() })
      .from(organizationInvitations)
      .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.status, 'pending')))
    const seats = (members?.value ?? 0) + (pendingInvitations?.value ?? 0)
    if (seats > targetSeatLimit) throw new SeatLimitExceededError()
  })
}

/** Team settings' danger-zone status read — same authDb rationale as `listPendingInvitations`: no tenant-context chicken-and-egg problem, and the caller (contracts.ts) already resolved a valid principal for this organization. */
export async function getOrganizationDeletionStatus(organizationId: string): Promise<OrganizationDeletionRecord | null> {
  const [{ and, eq }, { authDb }, schema] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
  ])
  const { organizationDeletionRequests } = schema

  const [row] = await authDb
    .select({
      id: organizationDeletionRequests.id,
      status: organizationDeletionRequests.status,
      gracePeriodEndsAt: organizationDeletionRequests.gracePeriodEndsAt,
      requestedByUserId: organizationDeletionRequests.requestedByUserId,
    })
    .from(organizationDeletionRequests)
    .where(and(eq(organizationDeletionRequests.organizationId, organizationId), eq(organizationDeletionRequests.status, 'pending')))
    .limit(1)
  if (!row) return null
  return { ...row, status: row.status as OrganizationDeletionRecord['status'] }
}

export interface ProcessPendingOrganizationDeletionsResult {
  processed: number
  errors: number
}

/**
 * The organization-deletion grace-period worker — same shape as legal.ts's
 * `processPendingDeletions` (account side) but deliberately its own sweep
 * over `organization_deletion_requests`, not a shared code path: hard-deletes
 * every organization whose pending request is past its grace period (the
 * cascade removes members/invitations/entitlements/resources with it), then
 * marks the request completed. A failed delete leaves that request untouched
 * for the next run rather than losing track of it.
 *
 * The actual hard delete is delegated to `organizations/deletion.ts`'s
 * `finalizeOrganizationDeletion` (plans/phase-1/30-stripe-billing-platform/tasks.md §9
 * "Integrate subscription-safe organization deletion") — it force-cancels any
 * still-active subscription and writes a durable financial-retention snapshot
 * BEFORE the organization row (and its cascade) is removed, so this worker
 * never again does a bare `authDb.delete(organizations)` itself.
 */
/**
 * Organization deletion requests finalised per batch.
 *
 * Small on purpose: each row triggers a full organization hard-delete plus a provider call, so the
 * batch is a read-ahead buffer for a queue whose real cost is per row.
 */
const ORGANIZATION_DELETION_BATCH = 50

export async function processPendingOrganizationDeletions(
  deps: { provider?: import('../billing/provider').BillingProvider } = {},
): Promise<ProcessPendingOrganizationDeletionsResult> {
  const [{ and, asc, eq, gt: gtOp, lt }, { authDb }, schema, { finalizeOrganizationDeletion }, { getBillingProvider }] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
    import('../organizations/deletion'),
    import('../billing/stripe-provider'),
  ])
  const { organizationDeletionRequests } = schema
  const provider = deps.provider ?? getBillingProvider()

  let processed = 0
  let errors = 0
  /*
   * The due queue arrives in bounded batches and this loop drains it (plan 12).
   *
   * A batch, not a page: each row is an organization whose owner asked for it to be deleted and whose
   * grace period has run out. Stopping at a batch boundary leaves a tenant's data in place past the
   * date it was promised to be gone, and the only thing that would report it is the absence of a
   * completion nobody is watching for.
   *
   * The cursor is the request id, which is the primary key and therefore already a total order — and
   * it advances past every row this run *looked at*, so a request whose finalize threw keeps its
   * `pending` status for the next run instead of stalling this one by being re-read forever.
   */
  let after: string | null = null
  for (;;) {
    const due = await authDb
      .select({ id: organizationDeletionRequests.id, organizationId: organizationDeletionRequests.organizationId })
      .from(organizationDeletionRequests)
      .where(and(
        eq(organizationDeletionRequests.status, 'pending'),
        lt(organizationDeletionRequests.gracePeriodEndsAt, new Date()),
        ...(after ? [gtOp(organizationDeletionRequests.id, after)] : []),
      ))
      .orderBy(asc(organizationDeletionRequests.id))
      .limit(ORGANIZATION_DELETION_BATCH)
    if (due.length === 0) break

    for (const dueRequest of due) {
      try {
        await finalizeOrganizationDeletion(dueRequest.organizationId, 'scheduled', { provider })
        await authDb
          .update(organizationDeletionRequests)
          .set({ status: 'completed', completedAt: new Date() })
          .where(eq(organizationDeletionRequests.id, dueRequest.id))
        processed++
      } catch (error) {
        errors++
        console.error('organization-lifecycle.process_pending_organization_deletions.failed', { error, organizationDeletionRequestId: dueRequest.id })
      }
    }

    after = due[due.length - 1].id
    if (due.length < ORGANIZATION_DELETION_BATCH) break
  }
  return { processed, errors }
}

/**
 * The one place outside this file allowed to trigger an organization hard-delete —
 * `organizations/deletion.ts`'s `finalizeOrganizationDeletion` calls this instead of importing
 * `authDb` itself (only files in `check-tenant-boundaries.mjs`'s `authDbAllowlist` may import the
 * auth-broker client directly; this file is one of the few, `organizations/deletion.ts` is not, by
 * design — it should have no reason to touch auth-broker tables beyond this one action).
 */
export async function hardDeleteOrganization(organizationId: string): Promise<void> {
  const [{ eq }, { authDb }, { organizations }] = await Promise.all([
    import('drizzle-orm'),
    import('../db/auth-db'),
    import('../db/schema'),
  ])
  await authDb.delete(organizations).where(eq(organizations.id, organizationId))
}
