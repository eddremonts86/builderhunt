/**
 * The only surface Team-account modules (plans/team-accounts) may import
 * from the security foundation. Every export here is an allowlisted DTO,
 * typed service function, or error type — never a schema table, a raw ORM
 * row, or a role-string literal. `scripts/check-tenant-boundaries.mjs`
 * enforces this: any file outside the foundation that imports
 * `~/shared/lib/db/schema`/`db/index` or compares `.role` against a string
 * literal directly (instead of calling `can()`) fails `security:boundaries`.
 */
import type { OrganizationRole, PermissionAction, ResourceAuthorizationContext, TenantPrincipal } from '../authorization/permissions'
import { can } from '../authorization/permissions'
import type {
  InvitableRole,
  InvitationRecord,
  MyOrganizationRecord,
  OrganizationMemberRecord,
  OrganizationRecord,
  SeatUsageRecord,
} from '../auth/organization-lifecycle'
import {
  getOrganizationLifecycle,
  getSeatUsage,
  listMyOrganizations,
  listOrganizationMembers,
  listPendingInvitations,
  OrganizationLifecycleError,
  SeatLimitExceededError,
} from '../auth/organization-lifecycle'
import { requireTenantPrincipal, TenantAuthorizationError } from '../auth/tenant-principal'

export type { OrganizationRole, PermissionAction, ResourceAuthorizationContext, TenantPrincipal }
export type { InvitableRole, MyOrganizationRecord }
export {
  can,
  getOrganizationLifecycle,
  getSeatUsage,
  listMyOrganizations,
  listOrganizationMembers,
  listPendingInvitations,
  requireTenantPrincipal,
}
export { OrganizationLifecycleError, SeatLimitExceededError, TenantAuthorizationError }

export interface OrganizationSummaryDto {
  id: string
  name: string
  slug: string
  role: OrganizationRole
  isPersonal: boolean
}

export interface OrganizationMemberDto {
  userId: string
  name: string
  email: string
  role: OrganizationRole
  joinedAt: string
}

export interface InvitationSummaryDto {
  id: string
  email: string
  role: InvitableRole
  status: InvitationRecord['status']
  expiresAt: string
}

export interface SeatUsageDto {
  used: number
  limit: number
}

export function toOrganizationSummaryDto(
  organization: OrganizationRecord,
  role: OrganizationRole,
  isPersonal: boolean,
): OrganizationSummaryDto {
  return { id: organization.id, name: organization.name, slug: organization.slug, role, isPersonal }
}

export function toOrganizationSummaryDtoList(records: MyOrganizationRecord[]): OrganizationSummaryDto[] {
  return records.map((record) => toOrganizationSummaryDto(record.organization, record.role, record.isPersonal))
}

export function toInvitationSummaryDto(invitation: InvitationRecord): InvitationSummaryDto {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
  }
}

export function toOrganizationMemberDto(member: OrganizationMemberRecord): OrganizationMemberDto {
  return {
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role,
    joinedAt: member.joinedAt.toISOString(),
  }
}

export function toSeatUsageDto(usage: SeatUsageRecord): SeatUsageDto {
  return { used: usage.used, limit: usage.limit }
}

/** Everything `TeamSettingsPage` needs for one render — the viewer's own role travels alongside so the client can gate controls with the same `can()` used server-side, never a hand-rolled role check. */
export interface TeamSnapshotDto {
  organization: OrganizationSummaryDto
  viewerRole: OrganizationRole
  members: OrganizationMemberDto[]
  pendingInvitations: InvitationSummaryDto[]
  seatUsage: SeatUsageDto
}

/** Composes the foundation reads behind `GET /api/organizations/team` so the route stays a thin auth-then-serialize wrapper with no direct DB access of its own. */
export async function getTeamSnapshot(principal: TenantPrincipal): Promise<TeamSnapshotDto | null> {
  const [myOrganizations, members, pendingInvitations, seatUsage] = await Promise.all([
    listMyOrganizations(principal.userId),
    listOrganizationMembers(principal.organizationId),
    listPendingInvitations(principal.organizationId),
    getSeatUsage(principal),
  ])

  const mine = myOrganizations.find((record) => record.organization.id === principal.organizationId)
  if (!mine) return null

  return {
    organization: toOrganizationSummaryDto(mine.organization, mine.role, mine.isPersonal),
    viewerRole: principal.role,
    members: members.map(toOrganizationMemberDto),
    pendingInvitations: pendingInvitations.map(toInvitationSummaryDto),
    seatUsage: toSeatUsageDto(seatUsage),
  }
}

/**
 * Per-target-role authorization for Team settings' member-row controls.
 * `can()` alone can't express these because `organization-lifecycle.ts`'s
 * real guards depend on the *target's* role too, not just the viewer's:
 * - `removeMember`: owner may remove anyone but the owner; an admin may
 *   remove members and may remove themselves, but not another admin.
 * - `changeMemberRole`/`transferOwnership`: owner-only, and transfer must
 *   target someone other than the viewer.
 * These mirror those guards exactly — presentation only, no new rules.
 */
export function canRemoveMember(
  viewerRole: OrganizationRole,
  viewerUserId: string,
  target: { userId: string; role: OrganizationRole },
): boolean {
  if (target.role === 'owner') return false
  if (viewerRole === 'owner') return true
  if (viewerRole === 'admin') return target.role !== 'admin' || target.userId === viewerUserId
  return false
}

export function canChangeMemberRole(viewerRole: OrganizationRole, targetRole: OrganizationRole): boolean {
  return viewerRole === 'owner' && targetRole !== 'owner'
}

export function canTransferOwnershipTo(viewerRole: OrganizationRole, viewerUserId: string, targetUserId: string): boolean {
  return viewerRole === 'owner' && targetUserId !== viewerUserId
}

/** An owner must transfer ownership before leaving — `removeMember` refuses to remove an owner-role target, self-removal included. */
export function canLeaveOrganization(viewerRole: OrganizationRole): boolean {
  return viewerRole !== 'owner'
}

export function isOwnerRole(role: OrganizationRole): boolean {
  return role === 'owner'
}
