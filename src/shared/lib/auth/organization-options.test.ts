import { describe, expect, it } from 'vitest'
import { ORGANIZATION_MEMBERSHIP_LIMIT, organizationOptions } from './organization-options'

describe('organizationOptions', () => {
  it('uses the reviewed static organization security policy', () => {
    expect(organizationOptions).toMatchObject({
      teams: { enabled: false },
      dynamicAccessControl: { enabled: false },
      creatorRole: 'owner',
      invitationExpiresIn: 60 * 60 * 24 * 7,
      requireEmailVerificationOnInvitation: true,
      cancelPendingInvitationsOnReInvite: true,
      membershipLimit: ORGANIZATION_MEMBERSHIP_LIMIT,
    })
  })

  it('keeps the product seat ceiling explicit and finite', () => {
    expect(ORGANIZATION_MEMBERSHIP_LIMIT).toBe(10)
    expect(Number.isFinite(organizationOptions.membershipLimit)).toBe(true)
  })
})
