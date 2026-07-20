import { describe, expect, it } from 'vitest'
import { can, type PermissionAction, type TenantPrincipal } from './permissions'

const principal = (role: TenantPrincipal['role'], userId = 'user-a'): TenantPrincipal => ({
  userId,
  organizationId: 'org-a',
  role,
  requestId: 'request-1',
})

describe('organization permissions', () => {
  const matrix: Array<{
    action: PermissionAction
    member: boolean
    admin: boolean
    owner: boolean
  }> = [
    { action: 'organization:read', member: true, admin: true, owner: true },
    { action: 'organization:update', member: false, admin: true, owner: true },
    { action: 'organization:invite', member: false, admin: true, owner: true },
    { action: 'organization:manage-members', member: false, admin: true, owner: true },
    { action: 'organization:transfer', member: false, admin: false, owner: true },
    { action: 'organization:delete', member: false, admin: false, owner: true },
  ]

  for (const row of matrix) {
    it(`${row.action} follows the static role matrix`, () => {
      expect(can(principal('member'), row.action)).toBe(row.member)
      expect(can(principal('admin'), row.action)).toBe(row.admin)
      expect(can(principal('owner'), row.action)).toBe(row.owner)
    })
  }
})

describe('tenant resource permissions', () => {
  it('allows every member to create inside the active organization', () => {
    expect(can(principal('member'), 'resource:create')).toBe(true)
  })

  it('allows organization-visible resources to current members', () => {
    expect(
      can(principal('member', 'viewer'), 'resource:read', {
        creatorUserId: 'creator',
        visibility: 'organization',
      }),
    ).toBe(true)
  })

  it('keeps private resources private from members and administrators', () => {
    const resource = { creatorUserId: 'creator', visibility: 'private' as const }
    expect(can(principal('member', 'viewer'), 'resource:read', resource)).toBe(false)
    expect(can(principal('admin', 'admin'), 'resource:read', resource)).toBe(false)
    expect(can(principal('owner', 'owner'), 'resource:read', resource)).toBe(false)
  })

  it('allows a creator to read and mutate their private resource', () => {
    const actor = principal('member', 'creator')
    const resource = { creatorUserId: 'creator', visibility: 'private' as const }
    expect(can(actor, 'resource:read', resource)).toBe(true)
    expect(can(actor, 'resource:update', resource)).toBe(true)
    expect(can(actor, 'resource:delete', resource)).toBe(true)
    expect(can(actor, 'resource:share', resource)).toBe(true)
  })

  it('allows admins and owners to manage organization-visible resources only', () => {
    const resource = { creatorUserId: 'creator', visibility: 'organization' as const }
    expect(can(principal('admin', 'admin'), 'resource:update', resource)).toBe(true)
    expect(can(principal('owner', 'owner'), 'resource:delete', resource)).toBe(true)
    expect(can(principal('member', 'viewer'), 'resource:update', resource)).toBe(false)
  })

  it('limits organization exports to admins and owners', () => {
    expect(can(principal('member'), 'resource:export')).toBe(false)
    expect(can(principal('admin'), 'resource:export')).toBe(true)
    expect(can(principal('owner'), 'resource:export')).toBe(true)
  })
})
