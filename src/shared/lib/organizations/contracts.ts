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
import type { InvitableRole, InvitationRecord, OrganizationRecord } from '../auth/organization-lifecycle'
import {
  getOrganizationLifecycle,
  OrganizationLifecycleError,
  SeatLimitExceededError,
} from '../auth/organization-lifecycle'
import { requireTenantPrincipal, TenantAuthorizationError } from '../auth/tenant-principal'

export type { OrganizationRole, PermissionAction, ResourceAuthorizationContext, TenantPrincipal }
export type { InvitableRole }
export { can, getOrganizationLifecycle, requireTenantPrincipal }
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

export function toInvitationSummaryDto(invitation: InvitationRecord): InvitationSummaryDto {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
  }
}
