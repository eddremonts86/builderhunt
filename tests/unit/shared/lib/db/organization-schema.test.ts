import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  authSessions,
  organizationInvitations,
  organizationMembers,
  organizations,
} from '~/shared/lib/db/schema'

describe('organization schema', () => {
  it('stores the active organization on authenticated sessions', () => {
    expect(authSessions.activeOrganizationId.name).toBe('active_organization_id')
    expect(authSessions.activeOrganizationId.notNull).toBe(false)
  })

  it('maps Better Auth organization models to explicit tables', () => {
    expect(getTableConfig(organizations).name).toBe('organizations')
    expect(getTableConfig(organizationMembers).name).toBe('organization_members')
    expect(getTableConfig(organizationInvitations).name).toBe('organization_invitations')
  })

  it('declares membership, invitation, and session lookup indexes', () => {
    const sessionIndexes = getTableConfig(authSessions).indexes.map((value) => value.config.name)
    const memberIndexes = getTableConfig(organizationMembers).indexes.map((value) => value.config.name)
    const invitationIndexes = getTableConfig(organizationInvitations).indexes.map((value) => value.config.name)

    expect(sessionIndexes).toContain('auth_sessions_active_organization_idx')
    expect(memberIndexes).toEqual(expect.arrayContaining([
      'organization_members_org_user_unique',
      'organization_members_user_idx',
    ]))
    expect(invitationIndexes).toEqual(expect.arrayContaining([
      'organization_invitations_email_idx',
      'organization_invitations_expires_idx',
    ]))
  })
})
