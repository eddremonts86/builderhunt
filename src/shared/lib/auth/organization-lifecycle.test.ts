import { describe, expect, it, vi } from 'vitest'
import {
  createOrganizationLifecycle,
  generateOrganizationSlug,
  OrganizationLifecycleError,
  SeatLimitExceededError,
  normalizeInvitationEmail,
  type InvitationRecord,
  type LifecycleDependencies,
  type LifecycleSession,
  type MembershipRecord,
} from './organization-lifecycle'

const NOW = new Date('2026-07-22T12:00:00Z')

function session(overrides: Partial<LifecycleSession> = {}): LifecycleSession {
  return {
    userId: 'user-a',
    sessionId: 'session-a',
    email: 'a@example.com',
    emailVerified: true,
    activeOrganizationId: 'org-1',
    authenticatedAt: NOW,
    ...overrides,
  }
}

function invitation(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  return {
    id: 'invite-1',
    organizationId: 'org-1',
    organizationName: 'Acme',
    email: 'invitee@example.com',
    role: 'member',
    status: 'pending',
    expiresAt: new Date('2026-07-29T12:00:00Z'),
    inviterId: 'user-a',
    ...overrides,
  }
}

function buildDeps(overrides: Partial<LifecycleDependencies> = {}): LifecycleDependencies {
  return {
    getSession: vi.fn().mockResolvedValue(session()),
    findMembership: vi.fn().mockResolvedValue(null),
    countSeats: vi.fn().mockResolvedValue(1),
    membershipLimit: 10,
    createOrganization: vi.fn().mockResolvedValue({ id: 'org-1', name: 'Acme', slug: 'acme' }),
    setActiveOrganization: vi.fn().mockResolvedValue(undefined),
    createInvitation: vi.fn().mockResolvedValue(invitation()),
    getInvitation: vi.fn().mockResolvedValue(invitation()),
    cancelInvitationRecord: vi.fn().mockResolvedValue(undefined),
    acceptInvitationRecord: vi.fn().mockResolvedValue(undefined),
    removeMemberRecord: vi.fn().mockResolvedValue(undefined),
    updateMemberRoleRecord: vi.fn().mockResolvedValue(undefined),
    transferOwnershipRecord: vi.fn().mockResolvedValue(undefined),
    deleteOrganizationRecord: vi.fn().mockResolvedValue(undefined),
    clearActiveOrganizationForUsers: vi.fn().mockResolvedValue(undefined),
    sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
    rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    audit: { write: vi.fn() },
    now: () => NOW,
    ...overrides,
  }
}

const request = new Request('https://builderhunt.test/api/organizations', {
  headers: { 'x-request-id': 'req-1' },
})

function membership(role: MembershipRecord['role'], overrides: Partial<MembershipRecord> = {}): MembershipRecord {
  return { organizationId: 'org-1', userId: 'user-a', role, ...overrides }
}

describe('normalizeInvitationEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeInvitationEmail('  Foo@Example.COM ')).toBe('foo@example.com')
  })
})

describe('generateOrganizationSlug', () => {
  it('slugifies the name and appends a random suffix', () => {
    const slug = generateOrganizationSlug('  Acme Corp!! ')
    expect(slug).toMatch(/^acme-corp-[0-9a-f]{8}$/)
  })

  it('falls back to a generic base when the name has no slug-safe characters', () => {
    const slug = generateOrganizationSlug('!!!')
    expect(slug).toMatch(/^team-[0-9a-f]{8}$/)
  })

  it('never collides on repeated calls with the same name', () => {
    const first = generateOrganizationSlug('Acme')
    const second = generateOrganizationSlug('Acme')
    expect(first).not.toBe(second)
  })
})

describe('switchActiveOrganization', () => {
  it('switches when the user has a membership in the target organization', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('member')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.switchActiveOrganization(request, 'org-2')

    expect(deps.setActiveOrganization).toHaveBeenCalledWith(await deps.getSession(request), 'org-2')
    expect(deps.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'organization.switch', result: 'allowed' }),
    )
  })

  it('a user with two memberships can switch to either organization', async () => {
    const findMembership = vi.fn(async (_userId: string, organizationId: string) =>
      organizationId === 'org-1' || organizationId === 'org-2' ? membership('member', { organizationId }) : null,
    )
    const deps = buildDeps({ findMembership })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.switchActiveOrganization(request, 'org-1')
    await lifecycle.switchActiveOrganization(request, 'org-2')

    expect(deps.setActiveOrganization).toHaveBeenCalledTimes(2)
  })

  it('rejects switching into an organization the user does not belong to', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(null) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.switchActiveOrganization(request, 'org-99')).rejects.toMatchObject({ status: 403 })
    expect(deps.setActiveOrganization).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated request', async () => {
    const deps = buildDeps({ getSession: vi.fn().mockResolvedValue(null) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.switchActiveOrganization(request, 'org-1')).rejects.toMatchObject({ status: 401 })
  })
})

describe('inviteMember', () => {
  it('rejects invites from a plain member', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('member')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(
      lifecycle.inviteMember(request, { organizationId: 'org-1', email: 'x@example.com', role: 'member' }),
    ).rejects.toMatchObject({ status: 403 })
    expect(deps.createInvitation).not.toHaveBeenCalled()
  })

  it('normalizes the invited email once before storing it', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('admin')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.inviteMember(request, { organizationId: 'org-1', email: '  Foo@Example.COM ', role: 'member' })

    expect(deps.createInvitation).toHaveBeenCalledWith(expect.objectContaining({ email: 'foo@example.com' }))
  })

  it('enforces the invite rate limit', async () => {
    const deps = buildDeps({
      findMembership: vi.fn().mockResolvedValue(membership('admin')),
      rateLimit: vi.fn().mockResolvedValue({ allowed: false }),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(
      lifecycle.inviteMember(request, { organizationId: 'org-1', email: 'x@example.com', role: 'member' }),
    ).rejects.toMatchObject({ status: 429 })
  })

  it('translates a concurrent seat-limit race into one success and one 409', async () => {
    let seatTaken = false
    const createInvitation = vi.fn(async () => {
      if (seatTaken) throw new SeatLimitExceededError()
      seatTaken = true
      return invitation()
    })
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('admin')), createInvitation })
    const lifecycle = createOrganizationLifecycle(deps)
    const invite = () => lifecycle.inviteMember(request, { organizationId: 'org-1', email: 'x@example.com', role: 'member' })

    const [first, second] = await Promise.allSettled([invite(), invite()])

    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    expect((second as PromiseRejectedResult).reason).toMatchObject({ status: 409 })
  })
})

describe('resendInvitation', () => {
  it('cancels the pending invitation and creates a fresh one', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('admin')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.resendInvitation(request, 'invite-1')

    expect(deps.cancelInvitationRecord).toHaveBeenCalledWith('invite-1')
    expect(deps.createInvitation).toHaveBeenCalledWith(expect.objectContaining({ email: 'invitee@example.com' }))
  })

  it('refuses to resend an invitation that already left the pending state', async () => {
    const deps = buildDeps({
      findMembership: vi.fn().mockResolvedValue(membership('admin')),
      getInvitation: vi.fn().mockResolvedValue(invitation({ status: 'accepted' })),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.resendInvitation(request, 'invite-1')).rejects.toMatchObject({ status: 409 })
    expect(deps.cancelInvitationRecord).not.toHaveBeenCalled()
  })

  it('translates a concurrent final-seat race into a 409, not an uncaught error', async () => {
    const createInvitation = vi.fn().mockRejectedValue(new SeatLimitExceededError())
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('admin')), createInvitation })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.resendInvitation(request, 'invite-1')).rejects.toMatchObject({ status: 409 })
    // The old invitation is still canceled — resend doesn't leave a stale
    // pending row behind just because the replacement lost the seat race.
    expect(deps.cancelInvitationRecord).toHaveBeenCalledWith('invite-1')
  })
})

describe('cancelInvitation', () => {
  it('requires elevated membership in the invitation organization', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('member')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.cancelInvitation(request, 'invite-1')).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a cross-org cancel — being elevated in your OWN org grants nothing against another org\'s invitation', async () => {
    // The caller is an owner of 'org-1' (their own org) but the invitation
    // being canceled belongs to 'org-2' — cancelInvitation must check
    // membership against the INVITATION's organization, never the caller's
    // own/active one, or any admin could cancel any other org's invites.
    const deps = buildDeps({
      getInvitation: vi.fn().mockResolvedValue(invitation({ organizationId: 'org-2' })),
      findMembership: vi.fn(async (_userId: string, organizationId: string) =>
        organizationId === 'org-1' ? membership('owner') : null,
      ),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.cancelInvitation(request, 'invite-1')).rejects.toMatchObject({ status: 403 })
    expect(deps.cancelInvitationRecord).not.toHaveBeenCalled()
  })
})

describe('acceptInvitation — enumeration safety', () => {
  const scenarios: Array<[string, Partial<LifecycleDependencies>, Partial<LifecycleSession>]> = [
    ['invitation does not exist', { getInvitation: vi.fn().mockResolvedValue(null) }, {}],
    [
      'authenticated email does not match the invited email',
      { getInvitation: vi.fn().mockResolvedValue(invitation({ email: 'someone-else@example.com' })) },
      {},
    ],
    ['authenticated email is not verified', {}, { emailVerified: false }],
    [
      'invitation already accepted (replayed)',
      { getInvitation: vi.fn().mockResolvedValue(invitation({ status: 'accepted', email: 'a@example.com' })) },
      {},
    ],
    [
      'invitation was revoked',
      { getInvitation: vi.fn().mockResolvedValue(invitation({ status: 'canceled', email: 'a@example.com' })) },
      {},
    ],
    [
      'invitation expired',
      {
        getInvitation: vi
          .fn()
          .mockResolvedValue(invitation({ email: 'a@example.com', expiresAt: new Date('2020-01-01T00:00:00Z') })),
      },
      {},
    ],
  ]

  it.each(scenarios)('%s yields the same generic error and status', async (_label, depsOverride, sessionOverride) => {
    const deps = buildDeps({
      getSession: vi.fn().mockResolvedValue(session(sessionOverride)),
      ...depsOverride,
    })
    const lifecycle = createOrganizationLifecycle(deps)

    const failure = await lifecycle.acceptInvitation(request, 'invite-1').catch((error) => error)

    expect(failure).toBeInstanceOf(OrganizationLifecycleError)
    expect(failure.status).toBe(403)
    expect(failure.message).toBe('This invitation is no longer valid')
    expect(deps.acceptInvitationRecord).not.toHaveBeenCalled()
  })

  it('accepts a valid, matching, verified, unexpired pending invitation', async () => {
    const deps = buildDeps({
      getSession: vi.fn().mockResolvedValue(session({ email: 'invitee@example.com' })),
      getInvitation: vi.fn().mockResolvedValue(invitation({ email: 'invitee@example.com' })),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    const result = await lifecycle.acceptInvitation(request, 'invite-1')

    expect(result).toEqual({ organizationId: 'org-1' })
    expect(deps.acceptInvitationRecord).toHaveBeenCalledWith('invite-1', 'user-a')
  })
})

describe('removeMember', () => {
  it('clears the removed member active organization on their sessions', async () => {
    const deps = buildDeps({
      findMembership: vi.fn(async (userId: string) =>
        userId === 'user-a' ? membership('admin') : membership('member', { userId: 'user-b' }),
      ),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.removeMember(request, 'org-1', 'user-b')

    expect(deps.removeMemberRecord).toHaveBeenCalledWith('org-1', 'user-b')
    expect(deps.clearActiveOrganizationForUsers).toHaveBeenCalledWith('org-1', ['user-b'])
  })

  it('refuses to remove the owner directly', async () => {
    const deps = buildDeps({
      findMembership: vi.fn(async (userId: string) =>
        userId === 'user-a' ? membership('admin') : membership('owner', { userId: 'user-b' }),
      ),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.removeMember(request, 'org-1', 'user-b')).rejects.toMatchObject({ status: 409 })
  })

  it('refuses an admin removing another admin', async () => {
    const deps = buildDeps({
      findMembership: vi.fn(async (userId: string) =>
        userId === 'user-a' ? membership('admin') : membership('admin', { userId: 'user-b' }),
      ),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.removeMember(request, 'org-1', 'user-b')).rejects.toMatchObject({ status: 403 })
  })

  it('allows a plain member to remove themselves (leave), no elevation required', async () => {
    const deps = buildDeps({
      findMembership: vi.fn().mockResolvedValue(membership('member')),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.removeMember(request, 'org-1', 'user-a')

    expect(deps.removeMemberRecord).toHaveBeenCalledWith('org-1', 'user-a')
    expect(deps.clearActiveOrganizationForUsers).toHaveBeenCalledWith('org-1', ['user-a'])
  })

  it('still refuses a plain member removing someone else', async () => {
    const deps = buildDeps({
      findMembership: vi.fn(async (userId: string) =>
        userId === 'user-a' ? membership('member') : membership('member', { userId: 'user-b' }),
      ),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.removeMember(request, 'org-1', 'user-b')).rejects.toMatchObject({ status: 403 })
    expect(deps.removeMemberRecord).not.toHaveBeenCalled()
  })

  it('rejects removal from a session that has not authenticated recently', async () => {
    const staleSession = session({ authenticatedAt: new Date(NOW.getTime() - 20 * 60 * 1000) })
    const deps = buildDeps({
      getSession: vi.fn().mockResolvedValue(staleSession),
      findMembership: vi.fn().mockResolvedValue(membership('admin')),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.removeMember(request, 'org-1', 'user-b')).rejects.toMatchObject({ status: 401 })
    expect(deps.removeMemberRecord).not.toHaveBeenCalled()
  })
})

describe('changeMemberRole — escalation prevention', () => {
  it('a member cannot change anyone else\'s role', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('member')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.changeMemberRole(request, 'org-1', 'user-b', 'admin')).rejects.toMatchObject({ status: 403 })
  })

  it('an admin cannot promote a member to admin (owner-only)', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('admin')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.changeMemberRole(request, 'org-1', 'user-b', 'admin')).rejects.toMatchObject({ status: 403 })
    expect(deps.updateMemberRoleRecord).not.toHaveBeenCalled()
  })

  it('the owner can change a member role', async () => {
    const deps = buildDeps({
      findMembership: vi.fn(async (userId: string) =>
        userId === 'user-a' ? membership('owner') : membership('member', { userId: 'user-b' }),
      ),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.changeMemberRole(request, 'org-1', 'user-b', 'admin')

    expect(deps.updateMemberRoleRecord).toHaveBeenCalledWith('org-1', 'user-b', 'admin')
  })

  it('cannot change the owner role through this path', async () => {
    const deps = buildDeps({
      findMembership: vi.fn(async (userId: string) =>
        userId === 'user-a' ? membership('owner') : membership('owner', { userId: 'user-b' }),
      ),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.changeMemberRole(request, 'org-1', 'user-b', 'member')).rejects.toMatchObject({ status: 409 })
  })
})

describe('transferOwnership', () => {
  it('performs the transfer atomically through a single dependency call', async () => {
    const deps = buildDeps({
      findMembership: vi.fn(async (userId: string) =>
        userId === 'user-a' ? membership('owner') : membership('admin', { userId: 'user-b' }),
      ),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.transferOwnership(request, 'org-1', 'user-b')

    expect(deps.transferOwnershipRecord).toHaveBeenCalledTimes(1)
    expect(deps.transferOwnershipRecord).toHaveBeenCalledWith('org-1', 'user-a', 'user-b')
  })

  it('only the owner may transfer ownership', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('admin')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.transferOwnership(request, 'org-1', 'user-b')).rejects.toMatchObject({ status: 403 })
    expect(deps.transferOwnershipRecord).not.toHaveBeenCalled()
  })

  it('refuses to transfer ownership to the current owner', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('owner')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.transferOwnership(request, 'org-1', 'user-a')).rejects.toMatchObject({ status: 409 })
  })

  it('requires a recently authenticated session', async () => {
    const staleSession = session({ authenticatedAt: new Date(NOW.getTime() - 20 * 60 * 1000) })
    const deps = buildDeps({
      getSession: vi.fn().mockResolvedValue(staleSession),
      findMembership: vi.fn().mockResolvedValue(membership('owner')),
    })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.transferOwnership(request, 'org-1', 'user-b')).rejects.toMatchObject({ status: 401 })
  })
})

describe('deleteOrganization', () => {
  it('only the owner may delete the organization', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('admin')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.deleteOrganization(request, 'org-1')).rejects.toMatchObject({ status: 403 })
    expect(deps.deleteOrganizationRecord).not.toHaveBeenCalled()
  })

  it('deletes when the owner has authenticated recently', async () => {
    const deps = buildDeps({ findMembership: vi.fn().mockResolvedValue(membership('owner')) })
    const lifecycle = createOrganizationLifecycle(deps)

    await lifecycle.deleteOrganization(request, 'org-1')

    expect(deps.deleteOrganizationRecord).toHaveBeenCalledWith('org-1')
  })
})

describe('createOrganization', () => {
  it('rejects an unauthenticated request', async () => {
    const deps = buildDeps({ getSession: vi.fn().mockResolvedValue(null) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.createOrganization(request, { name: 'Acme', slug: 'acme' })).rejects.toMatchObject({
      status: 401,
    })
  })

  it('enforces the create rate limit', async () => {
    const deps = buildDeps({ rateLimit: vi.fn().mockResolvedValue({ allowed: false }) })
    const lifecycle = createOrganizationLifecycle(deps)

    await expect(lifecycle.createOrganization(request, { name: 'Acme', slug: 'acme' })).rejects.toMatchObject({
      status: 429,
    })
  })
})
