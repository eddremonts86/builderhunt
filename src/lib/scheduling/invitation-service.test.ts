import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations } from '~/shared/lib/db/schema'
import { findInvitationByCapabilityHash } from '~/shared/lib/repositories/scheduling'
import { hashCapability } from './capability'
import {
  createInvitation,
  expireInvitation,
  getInvitation,
  invitationAuditDetails,
  isKnownTimeZone,
  listInvitations,
  markInvitationSent,
  revokeInvitation,
} from './invitation-service'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'inv-org'
const OTHER_ORG = 'inv-other-org'
const OWNER = 'inv-owner'
const OTHER_OWNER = 'inv-other-owner'
const ADMIN = 'inv-admin'

function principal(userId: string, role: TenantPrincipal['role'] = 'member', organizationId = ORG): TenantPrincipal {
  return { userId, organizationId, role, requestId: 'req-inv-test' }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('scheduling_invitation_service')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: ORG, name: 'Inv', slug: 'inv-org' },
    { id: OTHER_ORG, name: 'Other', slug: 'inv-other-org' },
  ])
  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'inv-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: OTHER_OWNER, name: 'Other', email: 'inv-other@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: ADMIN, name: 'Admin', email: 'inv-admin@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

function input(overrides: Partial<Parameters<typeof createInvitation>[2]> = {}) {
  return {
    roleTitle: 'Senior Rust Engineer',
    roleContext: 'Payments team, EU remote.',
    durationMinutes: 45,
    timezone: 'Europe/Copenhagen',
    modality: 'remote_call' as const,
    meetingUrl: 'https://meet.example.invalid/abc',
    ...overrides,
  }
}

async function create(actor = OWNER, overrides: Partial<Parameters<typeof createInvitation>[2]> = {}) {
  const result = await db.transaction((tx) => createInvitation(tx, principal(actor), input(overrides), 'policy-v1'))
  if (!result.ok) throw new Error(`create failed: ${result.error} ${result.message}`)
  return result.value
}

describe('invitation service (plan: calendar-scheduling-interview-intelligence, Phase 5)', () => {
  describe('create', () => {
    it('creates a draft and returns a capability secret exactly once', async () => {
      const { invitation, capabilitySecret } = await create()
      expect(invitation.status).toBe('draft')
      expect(invitation.version).toBe(1)
      expect(capabilitySecret).toMatch(/^[A-Za-z0-9_-]{43}$/)

      // The secret must never come back on a read path.
      const read = await db.transaction((tx) => getInvitation(tx, principal(OWNER), invitation.id))
      expect(read.ok).toBe(true)
      expect(JSON.stringify(read)).not.toContain(capabilitySecret)
    })

    it('stores only the hash, and that hash resolves the invitation publicly', async () => {
      const { invitation, capabilitySecret } = await create()
      const row = await db.transaction((tx) => getInvitation(tx, principal(OWNER), invitation.id))
      if (!row.ok) throw new Error('unreachable')
      // Whatever the row carries, it is not the secret.
      expect(JSON.stringify(row.value)).not.toContain(capabilitySecret)

      const publicView = await db.transaction((tx) =>
        findInvitationByCapabilityHash(tx, hashCapability(capabilitySecret), new Date()))
      expect(publicView?.id).toBe(invitation.id)
    })

    it('snapshots the role context rather than referencing it', async () => {
      const { invitation } = await create(OWNER, { roleTitle: '  Staff Engineer  ', roleContext: 'Original wording.' })
      expect(invitation.roleTitle).toBe('Staff Engineer')
      expect(invitation.roleContext).toBe('Original wording.')
    })

    it.each([
      ['blank title', { roleTitle: '   ' }],
      ['overlong title', { roleTitle: 'x'.repeat(201) }],
      ['overlong context', { roleContext: 'x'.repeat(4001) }],
      ['zero duration', { durationMinutes: 0 }],
      ['fractional duration', { durationMinutes: 30.5 }],
      ['duration over the ceiling', { durationMinutes: 481 }],
      ['unknown timezone', { timezone: 'Mars/Olympus_Mons' }],
      ['expiry in the past', { expiresAt: new Date(Date.now() - 1000) }],
    ])('rejects %s', async (_label, overrides) => {
      const result = await db.transaction((tx) =>
        createInvitation(tx, principal(OWNER), input(overrides), 'policy-v1'))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error).toBe('invalid_input')
    })

    it('requires a joining detail that matches the modality', async () => {
      const remoteWithoutUrl = await db.transaction((tx) =>
        createInvitation(tx, principal(OWNER), input({ meetingUrl: null }), 'policy-v1'))
      expect(remoteWithoutUrl.ok).toBe(false)

      const inPersonWithoutLocation = await db.transaction((tx) =>
        createInvitation(tx, principal(OWNER), input({ modality: 'in_person', meetingUrl: null }), 'policy-v1'))
      expect(inPersonWithoutLocation.ok).toBe(false)

      const inPersonOk = await db.transaction((tx) =>
        createInvitation(tx, principal(OWNER), input({ modality: 'in_person', meetingUrl: null, location: 'Dragør office' }), 'policy-v1'))
      expect(inPersonOk.ok).toBe(true)
    })
  })

  describe('isolation', () => {
    it('does not leak another owner\'s invitation, even to an organization admin', async () => {
      const { invitation } = await create(OWNER)

      for (const actor of [principal(OTHER_OWNER), principal(ADMIN, 'admin'), principal(ADMIN, 'owner')]) {
        const result = await db.transaction((tx) => getInvitation(tx, actor, invitation.id))
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        // `not_found`, not `forbidden`: a non-owner must not learn the row exists.
        expect(result.error).toBe('not_found')
      }
    })

    it('does not leak across organizations', async () => {
      const { invitation } = await create(OWNER)
      const result = await db.transaction((tx) =>
        getInvitation(tx, principal(OWNER, 'member', OTHER_ORG), invitation.id))
      expect(result.ok).toBe(false)
    })

    it('lists only the caller\'s own invitations', async () => {
      const mine = await create(OWNER)
      await create(OTHER_OWNER)
      const listed = await db.transaction((tx) => listInvitations(tx, principal(OWNER)))
      expect(listed.map((i) => i.id)).toContain(mine.invitation.id)
      const others = await db.transaction((tx) => listInvitations(tx, principal(OTHER_OWNER)))
      expect(others.map((i) => i.id)).not.toContain(mine.invitation.id)
    })
  })

  describe('transitions', () => {
    it('draft -> sent, and a resend is allowed without minting a new capability', async () => {
      const { invitation, capabilitySecret } = await create()
      const sent = await db.transaction((tx) => markInvitationSent(tx, principal(OWNER), invitation.id, invitation.version))
      expect(sent.ok).toBe(true)
      if (!sent.ok) throw new Error('unreachable')
      expect(sent.value.status).toBe('sent')

      const resent = await db.transaction((tx) => markInvitationSent(tx, principal(OWNER), invitation.id, sent.value.version))
      expect(resent.ok).toBe(true)

      // The original link still opens it — forwarding an old email must keep working.
      const stillValid = await db.transaction((tx) =>
        findInvitationByCapabilityHash(tx, hashCapability(capabilitySecret), new Date()))
      expect(stillValid?.id).toBe(invitation.id)
    })

    it('revoke is terminal and kills the capability', async () => {
      const { invitation, capabilitySecret } = await create()
      const revoked = await db.transaction((tx) => revokeInvitation(tx, principal(OWNER), invitation.id, invitation.version))
      expect(revoked.ok).toBe(true)

      const afterRevoke = await db.transaction((tx) =>
        findInvitationByCapabilityHash(tx, hashCapability(capabilitySecret), new Date()))
      expect(afterRevoke).toBeNull()

      // And nothing moves it back out of revoked.
      const resend = await db.transaction((tx) => markInvitationSent(tx, principal(OWNER), invitation.id, invitation.version + 1))
      expect(resend.ok).toBe(false)
      if (resend.ok) throw new Error('unreachable')
      expect(resend.error).toBe('invalid_transition')
    })

    it('expire refuses to run twice', async () => {
      const { invitation } = await create()
      const first = await db.transaction((tx) => expireInvitation(tx, principal(OWNER), invitation.id, invitation.version))
      expect(first.ok).toBe(true)
      if (!first.ok) throw new Error('unreachable')
      const second = await db.transaction((tx) => expireInvitation(tx, principal(OWNER), invitation.id, first.value.version))
      expect(second.ok).toBe(false)
    })

    it('reports a version conflict rather than clobbering a concurrent change', async () => {
      const { invitation } = await create()
      // Someone else already advanced the row; our expectedVersion is stale.
      await db.transaction((tx) => markInvitationSent(tx, principal(OWNER), invitation.id, invitation.version))
      const stale = await db.transaction((tx) => revokeInvitation(tx, principal(OWNER), invitation.id, invitation.version))
      expect(stale.ok).toBe(false)
      if (stale.ok) throw new Error('unreachable')
      expect(stale.error).toBe('version_conflict')
    })

    it('a non-owner cannot drive any transition', async () => {
      const { invitation } = await create(OWNER)
      const result = await db.transaction((tx) => revokeInvitation(tx, principal(ADMIN, 'admin'), invitation.id, invitation.version))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error).toBe('not_found')
    })
  })

  describe('audit details', () => {
    it('carries the invitation identity and nothing about the candidate or the secret', async () => {
      const { invitation, capabilitySecret } = await create()
      const details = invitationAuditDetails(invitation)
      const serialised = JSON.stringify(details)
      expect(details.invitationId).toBe(invitation.id)
      expect(serialised).not.toContain(capabilitySecret)
      expect(serialised).not.toContain(hashCapability(capabilitySecret))
      expect(serialised).not.toContain('Senior Rust Engineer')
    })

    it('the repository never returns the capability hash on any owner read path', async () => {
      // `invitationColumns` in repositories/scheduling.ts deliberately omits capability_hash, so
      // the hash cannot reach a DTO, a log line or an audit entry by accident. Asserted here
      // because it is a property of the data layer that this service depends on.
      const { invitation, capabilitySecret } = await create()
      const hash = hashCapability(capabilitySecret)
      expect(JSON.stringify(invitation)).not.toContain(hash)

      const read = await db.transaction((tx) => getInvitation(tx, principal(OWNER), invitation.id))
      expect(JSON.stringify(read)).not.toContain(hash)

      const listed = await db.transaction((tx) => listInvitations(tx, principal(OWNER)))
      expect(JSON.stringify(listed)).not.toContain(hash)
    })
  })

  describe('isKnownTimeZone', () => {
    it.each(['Europe/Copenhagen', 'UTC', 'America/New_York', 'Asia/Tokyo'])('accepts %s', (tz) => {
      expect(isKnownTimeZone(tz)).toBe(true)
    })
    it.each(['', 'Mars/Olympus_Mons', 'Europe/Nowhere', 'x'.repeat(101)])('rejects %s', (tz) => {
      expect(isKnownTimeZone(tz)).toBe(false)
    })
  })
})
