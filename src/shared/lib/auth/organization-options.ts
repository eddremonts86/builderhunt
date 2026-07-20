import type { OrganizationOptions } from 'better-auth/plugins/organization'

export const ORGANIZATION_MEMBERSHIP_LIMIT = 10

export const organizationOptions = {
  teams: { enabled: false },
  dynamicAccessControl: { enabled: false },
  creatorRole: 'owner',
  invitationExpiresIn: 60 * 60 * 24 * 7,
  requireEmailVerificationOnInvitation: true,
  cancelPendingInvitationsOnReInvite: true,
  membershipLimit: ORGANIZATION_MEMBERSHIP_LIMIT,
} as const satisfies OrganizationOptions
