import { describe, expect, it, vi } from 'vitest'
import { buildPersonalOrganizationSeed, resolveDefaultActiveOrganizationId } from '~/shared/lib/auth/personal-organization'

describe('personal organization bootstrap', () => {
  it('builds deterministic non-PII organization and owner records', () => {
    const first = buildPersonalOrganizationSeed('user-sensitive-id')
    const second = buildPersonalOrganizationSeed('user-sensitive-id')
    expect(first).toEqual(second)
    expect(JSON.stringify(first.organization)).not.toContain('user-sensitive-id')
    expect(first.member.userId).toBe('user-sensitive-id')
    expect(first.member.role).toBe('owner')
    expect(first.entitlement).toMatchObject({ tier: 'free', status: 'active', seatLimit: 1 })
  })
})

describe('resolveDefaultActiveOrganizationId', () => {
  it('returns the userʼs earliest membership organization id', async () => {
    const findFirstMembership = vi.fn().mockResolvedValue({ organizationId: 'org-personal' })
    const organizationId = await resolveDefaultActiveOrganizationId('user-a', { findFirstMembership })

    expect(organizationId).toBe('org-personal')
    expect(findFirstMembership).toHaveBeenCalledWith('user-a')
  })

  it('returns null when the user has no memberships', async () => {
    const findFirstMembership = vi.fn().mockResolvedValue(null)
    const organizationId = await resolveDefaultActiveOrganizationId('user-a', { findFirstMembership })

    expect(organizationId).toBeNull()
  })
})
