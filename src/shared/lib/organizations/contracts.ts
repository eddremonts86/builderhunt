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
  OrganizationDeletionRecord,
  OrganizationMemberRecord,
  OrganizationRecord,
  SeatUsageRecord,
} from '../auth/organization-lifecycle'
import {
  getOrganizationDeletionStatus,
  getOrganizationLifecycle,
  getSeatUsage,
  listInvitationsForEmail,
  listMyOrganizations,
  listOrganizationMembers,
  listPendingInvitations,
  OrganizationLifecycleError,
  SeatLimitExceededError,
  STALE_SESSION_ERROR_MESSAGE,
} from '../auth/organization-lifecycle'
import { requireTenantPrincipal, TenantAuthorizationError } from '../auth/tenant-principal'

export type { OrganizationRole, PermissionAction, ResourceAuthorizationContext, TenantPrincipal }
export type { InvitableRole, MyOrganizationRecord }
export {
  can,
  getOrganizationLifecycle,
  getSeatUsage,
  listInvitationsForEmail,
  listMyOrganizations,
  listOrganizationMembers,
  listPendingInvitations,
  requireTenantPrincipal,
  STALE_SESSION_ERROR_MESSAGE,
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

/**
 * Owner-visible reason a Team-to-one-seat-tier subscription downgrade cannot be sent to Stripe yet
 * (plans/stripe-billing-platform/tasks.md §7 "Enforce Team downgrade seat blockers"). `currentSeatsUsed`
 * mirrors `SeatUsageDto.used` exactly (accepted members plus usable/pending invitations) — the same
 * count the seat-limit invite-time guard already enforces, so the number an owner sees here always
 * matches what `/settings/team` shows them. Never implies membership was or will be changed
 * automatically — the owner must free seats themselves before retrying.
 */
export interface SeatDowngradeBlockerDto {
  currentSeatsUsed: number
  targetSeatLimit: number
  manageTeamUrl: '/settings/team'
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

/** What a signed-in INVITEE sees about their own pending invitations — never their own email back, never who else was invited, just enough to decide whether to open and accept one. */
export interface MyPendingInvitationDto {
  id: string
  organizationName: string
  role: InvitableRole
  expiresAt: string
}

export function toMyPendingInvitationDto(invitation: InvitationRecord): MyPendingInvitationDto {
  return {
    id: invitation.id,
    organizationName: invitation.organizationName,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
  }
}

export interface OrganizationDeletionStatusDto {
  id: string
  gracePeriodEndsAt: string
}

export function toOrganizationDeletionStatusDto(record: OrganizationDeletionRecord): OrganizationDeletionStatusDto {
  return { id: record.id, gracePeriodEndsAt: record.gracePeriodEndsAt.toISOString() }
}

/** Everything `TeamSettingsPage` needs for one render — the viewer's own role travels alongside so the client can gate controls with the same `can()` used server-side, never a hand-rolled role check. */
export interface TeamSnapshotDto {
  organization: OrganizationSummaryDto
  viewerRole: OrganizationRole
  members: OrganizationMemberDto[]
  pendingInvitations: InvitationSummaryDto[]
  seatUsage: SeatUsageDto
  /** Non-null only while this organization has a pending (not yet completed/cancelled) deletion request. */
  pendingDeletion: OrganizationDeletionStatusDto | null
}

/** Composes the foundation reads behind `GET /api/organizations/team` so the route stays a thin auth-then-serialize wrapper with no direct DB access of its own. */
export async function getTeamSnapshot(principal: TenantPrincipal): Promise<TeamSnapshotDto | null> {
  const [myOrganizations, members, pendingInvitations, seatUsage, deletionStatus] = await Promise.all([
    listMyOrganizations(principal.userId),
    listOrganizationMembers(principal.organizationId),
    listPendingInvitations(principal.organizationId),
    getSeatUsage(principal),
    getOrganizationDeletionStatus(principal.organizationId),
  ])

  const mine = myOrganizations.find((record) => record.organization.id === principal.organizationId)
  if (!mine) return null

  return {
    organization: toOrganizationSummaryDto(mine.organization, mine.role, mine.isPersonal),
    viewerRole: principal.role,
    members: members.map(toOrganizationMemberDto),
    pendingInvitations: pendingInvitations.map(toInvitationSummaryDto),
    seatUsage: toSeatUsageDto(seatUsage),
    pendingDeletion: deletionStatus ? toOrganizationDeletionStatusDto(deletionStatus) : null,
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

/** Whether a "manage this team" affordance (e.g. a shortcut into `/settings/team`) should be shown for a given membership role — a plain member never gets one, since every mutating control on that page is already hidden from them. */
export function canManageTeamSettings(role: OrganizationRole): boolean {
  return role === 'owner' || role === 'admin'
}

