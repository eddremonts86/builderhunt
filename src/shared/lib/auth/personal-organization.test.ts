import { describe, expect, it } from 'vitest'
import { buildPersonalOrganizationSeed } from './personal-organization'

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
