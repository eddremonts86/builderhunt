import { createHash } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, organizations, privacyConsents } from '../db/schema'
import {
  appendConsentDecision,
  deleteSubmission,
  findConsentsByIds,
  findInvitationByCapabilityHash,
  findInvitationForOwner,
  findInvitationTenantByCapabilityHash,
  findSubmissionByInvitation,
  insertInvitation,
  listAvailabilityOverrides,
  listAvailabilityRules,
  listConsentsForInvitation,
  listExpiredInvitations,
  listExpiredSubmissions,
  listInvitationsForOwner,
  listLinksForSubmission,
  markInvitationExpired,
  recordLinkAttestation,
  replaceAvailabilityPolicy,
  updateInvitationStateWithVersion,
  updateLinkImportState,
  upsertLink,
  upsertSubmission,
  withdrawConsent,
} from './scheduling'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'sch-org-a'
const ORG_B = 'sch-org-b'
const OWNER = 'sch-owner'
const OTHER = 'sch-other'

function hashOf(secret: string) {
  return createHash('sha256').update(secret).digest('hex')
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_scheduling')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: ORG_A, name: 'A', slug: 'sch-org-a' },
    { id: ORG_B, name: 'B', slug: 'sch-org-b' },
  ])
  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'sch-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: OTHER, name: 'Other', email: 'sch-other@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

let invitationCounter = 0
function invitationInput(overrides: Partial<Parameters<typeof insertInvitation>[1]> = {}) {
  invitationCounter += 1
  return {
    organizationId: ORG_A,
    ownerUserId: OWNER,
    roleTitle: 'Engineer',
    roleContext: 'Backend team',
    durationMinutes: 60,
    timezone: 'Europe/Copenhagen',
    modality: 'remote_call',
    capabilityHash: hashOf(`secret-${invitationCounter}`),
    policyVersion: 'v1',
    ...overrides,
  }
}

describe('availability policy', () => {
  it('replaces the owner whole policy atomically', async () => {
    const rule = {
      timezone: 'Europe/Copenhagen',
      weekdays: [1, 2, 3],
      localStart: '09:00:00',
      localEnd: '17:00:00',
      slotMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      horizonDays: 30,
      enabled: true,
    }
    await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG_A, OWNER, { rules: [rule], overrides: [] }))
    expect(await db.transaction((tx) => listAvailabilityRules(tx, ORG_A, OWNER))).toHaveLength(1)

    // A second replace must leave exactly one rule, not two.
    await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG_A, OWNER, {
      rules: [{ ...rule, localEnd: '18:00:00' }],
      overrides: [{ localDate: '2026-08-05', localStart: null, localEnd: null, kind: 'blocked', timezone: 'Europe/Copenhagen' }],
    }))
    const rules = await db.transaction((tx) => listAvailabilityRules(tx, ORG_A, OWNER))
    expect(rules).toHaveLength(1)
    expect(rules[0].localEnd).toBe('18:00:00')
    expect(await db.transaction((tx) => listAvailabilityOverrides(tx, ORG_A, OWNER))).toHaveLength(1)
  })

  it('replacing one owner policy never clears another owner rules', async () => {
    const rule = {
      timezone: 'UTC', weekdays: [1], localStart: '10:00:00', localEnd: '12:00:00',
      slotMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, horizonDays: 10, enabled: true,
    }
    await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG_A, OTHER, { rules: [rule], overrides: [] }))
    await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG_A, OWNER, { rules: [rule], overrides: [] }))

    expect(await db.transaction((tx) => listAvailabilityRules(tx, ORG_A, OTHER))).toHaveLength(1)
  })

  it('rejects an overnight rule at the database level', async () => {
    await expect(
      db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG_A, OWNER, {
        rules: [{
          timezone: 'UTC', weekdays: [1], localStart: '22:00:00', localEnd: '06:00:00',
          slotMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, horizonDays: 10, enabled: true,
        }],
        overrides: [],
      })),
    ).rejects.toThrow()
  })
})

describe('invitations (organizer view)', () => {
  it('inserts and reads back, scoped to owner and tenant', async () => {
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    expect(await db.transaction((tx) => findInvitationForOwner(tx, ORG_A, OWNER, created.id))).not.toBeNull()
    expect(await db.transaction((tx) => findInvitationForOwner(tx, ORG_A, OTHER, created.id))).toBeNull()
    expect(await db.transaction((tx) => findInvitationForOwner(tx, ORG_B, OWNER, created.id))).toBeNull()
  })

  it('never exposes the capability hash to any caller', async () => {
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    expect(created).not.toHaveProperty('capabilityHash')
    const listed = await db.transaction((tx) => listInvitationsForOwner(tx, ORG_A, OWNER))
    for (const row of listed) expect(row).not.toHaveProperty('capabilityHash')
  })

  it('optimistic state change succeeds once and refuses a stale retry', async () => {
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    const sent = await db.transaction((tx) => updateInvitationStateWithVersion(tx, ORG_A, OWNER, created.id, 1, { status: 'sent' }))
    expect(sent?.status).toBe('sent')
    expect(sent?.version).toBe(2)

    expect(await db.transaction((tx) => updateInvitationStateWithVersion(tx, ORG_A, OWNER, created.id, 1, { status: 'revoked' }))).toBeNull()
    expect((await db.transaction((tx) => findInvitationForOwner(tx, ORG_A, OWNER, created.id)))?.status).toBe('sent')
  })

  it('state change is refused for a non-owner', async () => {
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    expect(await db.transaction((tx) => updateInvitationStateWithVersion(tx, ORG_A, OTHER, created.id, 1, { status: 'revoked' }))).toBeNull()
  })
})

describe('invitations (public capability view)', () => {
  it('resolves a live invitation by hash and omits organization/owner/hash', async () => {
    const secret = 'live-secret'
    await db.transaction((tx) => insertInvitation(tx, invitationInput({ capabilityHash: hashOf(secret), status: 'sent' } as never)))
    const dto = await db.transaction((tx) => findInvitationByCapabilityHash(tx, hashOf(secret), new Date()))
    expect(dto).not.toBeNull()
    expect(dto).not.toHaveProperty('organizationId')
    expect(dto).not.toHaveProperty('ownerUserId')
    expect(dto).not.toHaveProperty('capabilityHash')
    expect(dto).not.toHaveProperty('revokedAt')
  })

  it('returns null — not a distinguishable error — for an unknown hash', async () => {
    expect(await db.transaction((tx) => findInvitationByCapabilityHash(tx, hashOf('never-issued'), new Date()))).toBeNull()
  })

  it('returns null for a revoked invitation', async () => {
    const secret = 'revoked-secret'
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput({ capabilityHash: hashOf(secret) })))
    await db.transaction((tx) => updateInvitationStateWithVersion(tx, ORG_A, OWNER, created.id, 1, { status: 'revoked', revokedAt: new Date() }))
    expect(await db.transaction((tx) => findInvitationByCapabilityHash(tx, hashOf(secret), new Date()))).toBeNull()
  })

  it('returns null for an expired invitation, by both timestamp and status', async () => {
    const expiredByTime = 'expired-time-secret'
    await db.transaction((tx) => insertInvitation(tx, invitationInput({
      capabilityHash: hashOf(expiredByTime),
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    })))
    expect(await db.transaction((tx) => findInvitationByCapabilityHash(tx, hashOf(expiredByTime), new Date()))).toBeNull()

    const expiredByStatus = 'expired-status-secret'
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput({ capabilityHash: hashOf(expiredByStatus) })))
    await db.transaction((tx) => markInvitationExpired(tx, ORG_A, created.id))
    expect(await db.transaction((tx) => findInvitationByCapabilityHash(tx, hashOf(expiredByStatus), new Date()))).toBeNull()
  })

  it('returns null for a declined invitation', async () => {
    const secret = 'declined-secret'
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput({ capabilityHash: hashOf(secret) })))
    await db.transaction((tx) => updateInvitationStateWithVersion(tx, ORG_A, OWNER, created.id, 1, { status: 'declined' }))
    expect(await db.transaction((tx) => findInvitationByCapabilityHash(tx, hashOf(secret), new Date()))).toBeNull()
  })

  it('resolves the owning tenant separately so the route can enter context server-side', async () => {
    const secret = 'tenant-secret'
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput({ capabilityHash: hashOf(secret) })))
    const tenant = await db.transaction((tx) => findInvitationTenantByCapabilityHash(tx, hashOf(secret)))
    expect(tenant).toEqual({ organizationId: ORG_A, ownerUserId: OWNER, id: created.id })
  })
})

describe('candidate submissions and links', () => {
  async function seedSubmission(suffix: string) {
    const created = await db.transaction((tx) => insertInvitation(tx, invitationInput({ capabilityHash: hashOf(`sub-${suffix}`) })))
    const submission = await db.transaction((tx) => upsertSubmission(tx, {
      organizationId: ORG_A,
      invitationId: created.id,
      displayName: 'Candidate',
      emailNormalized: `cand-${suffix}@test.invalid`,
      retentionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }))
    return { invitationId: created.id, submission }
  }

  it('upsert keeps one submission per invitation', async () => {
    const { invitationId } = await seedSubmission('one')
    await db.transaction((tx) => upsertSubmission(tx, {
      organizationId: ORG_A, invitationId, displayName: 'Renamed', emailNormalized: 'renamed@test.invalid',
      retentionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }))
    const found = await db.transaction((tx) => findSubmissionByInvitation(tx, ORG_A, invitationId))
    expect(found?.displayName).toBe('Renamed')
  })

  it('a submission is invisible under the wrong tenant predicate', async () => {
    const { invitationId } = await seedSubmission('tenant')
    expect(await db.transaction((tx) => findSubmissionByInvitation(tx, ORG_B, invitationId))).toBeNull()
  })

  it('upsert of the same normalized URL updates rather than duplicates', async () => {
    const { submission } = await seedSubmission('link')
    const base = {
      organizationId: ORG_A,
      submissionId: submission.id,
      url: 'https://example.com/me',
      normalizedUrl: 'https://example.com/me',
      sourceType: 'personal_site',
      acquisitionMode: 'user_submitted',
      policyDecision: 'not_importable',
    }
    await db.transaction((tx) => upsertLink(tx, base))
    await db.transaction((tx) => upsertLink(tx, { ...base, label: 'Portfolio' }))
    const links = await db.transaction((tx) => listLinksForSubmission(tx, ORG_A, submission.id))
    expect(links).toHaveLength(1)
    expect(links[0].label).toBe('Portfolio')
  })

  it('an authorized_crawl decision is impossible without a recorded attestation', async () => {
    const { submission } = await seedSubmission('attest')
    await expect(
      db.transaction((tx) => upsertLink(tx, {
        organizationId: ORG_A,
        submissionId: submission.id,
        url: 'https://example.com/blog',
        normalizedUrl: 'https://example.com/blog',
        sourceType: 'personal_site',
        acquisitionMode: 'authorized_crawl',
        policyDecision: 'authorized_crawl',
      })),
    ).rejects.toThrow()
  })

  it('recording an attestation permits the authorized_crawl decision', async () => {
    const { submission } = await seedSubmission('attest-ok')
    const link = await db.transaction((tx) => upsertLink(tx, {
      organizationId: ORG_A,
      submissionId: submission.id,
      url: 'https://example.com/ok',
      normalizedUrl: 'https://example.com/ok',
      sourceType: 'personal_site',
      acquisitionMode: 'authorized_crawl',
      policyDecision: 'not_importable',
    }))
    const attested = await db.transaction((tx) => recordLinkAttestation(tx, ORG_A, submission.id, link.id, {
      noticeVersion: 'v1',
      attestedAt: new Date(),
      policyDecision: 'authorized_crawl',
    }))
    expect(attested?.policyDecision).toBe('authorized_crawl')
    expect(attested?.authorizationNoticeVersion).toBe('v1')
  })

  it('a link mutation scoped to the wrong submission does nothing', async () => {
    const first = await seedSubmission('cross-1')
    const second = await seedSubmission('cross-2')
    const link = await db.transaction((tx) => upsertLink(tx, {
      organizationId: ORG_A,
      submissionId: first.submission.id,
      url: 'https://example.com/first',
      normalizedUrl: 'https://example.com/first',
      sourceType: 'personal_site',
      acquisitionMode: 'user_submitted',
      policyDecision: 'not_importable',
    }))

    // Correct link id, but a capability for the OTHER invitation's submission.
    expect(await db.transaction((tx) => updateLinkImportState(tx, ORG_A, second.submission.id, link.id, 'queued'))).toBeNull()
    expect(await db.transaction((tx) => updateLinkImportState(tx, ORG_A, first.submission.id, link.id, 'queued'))).not.toBeNull()
  })
})

describe('worker retention sweeps', () => {
  it('lists and expires only past-due, still-open invitations', async () => {
    const past = await db.transaction((tx) => insertInvitation(tx, invitationInput({
      capabilityHash: hashOf('sweep-past'), expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    })))
    await db.transaction((tx) => insertInvitation(tx, invitationInput({
      capabilityHash: hashOf('sweep-future'), expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })))

    const due = await db.transaction((tx) => listExpiredInvitations(tx, ORG_A, new Date(), 50))
    expect(due.map((r) => r.id)).toContain(past.id)

    expect(await db.transaction((tx) => markInvitationExpired(tx, ORG_A, past.id))).not.toBeNull()
    // Already expired — a second sweep must not re-process it.
    expect(await db.transaction((tx) => markInvitationExpired(tx, ORG_A, past.id))).toBeNull()
  })

  it('lists and deletes submissions past their retention window', async () => {
    const invitation = await db.transaction((tx) => insertInvitation(tx, invitationInput({ capabilityHash: hashOf('retention') })))
    const submission = await db.transaction((tx) => upsertSubmission(tx, {
      organizationId: ORG_A,
      invitationId: invitation.id,
      displayName: 'Old',
      emailNormalized: 'old@test.invalid',
      retentionExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
    }))

    const expired = await db.transaction((tx) => listExpiredSubmissions(tx, ORG_A, new Date(), 50))
    expect(expired.map((r) => r.id)).toContain(submission.id)

    expect(await db.transaction((tx) => deleteSubmission(tx, ORG_A, submission.id))).not.toBeNull()
    expect(await db.transaction((tx) => findSubmissionByInvitation(tx, ORG_A, invitation.id))).toBeNull()
  })

  it('a sweep in one tenant never sees another tenant rows', async () => {
    const expired = await db.transaction((tx) => listExpiredInvitations(tx, ORG_B, new Date(), 50))
    expect(expired).toHaveLength(0)
  })
})

describe('consent ledger', () => {
  function decision(invitationId: string, overrides: Partial<Parameters<typeof appendConsentDecision>[1]> = {}) {
    return {
      organizationId: ORG_A,
      invitationId,
      subjectEmailHash: hashOf('candidate@test.invalid'),
      purpose: 'terms_and_privacy',
      noticeVersion: '2026-07-01',
      decision: 'accepted',
      requestEvidenceHash: hashOf('request-evidence'),
      ...overrides,
    }
  }

  it('appends a decision and returns it without the evidence hash', async () => {
    const invitation = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    const row = await db.transaction((tx) => appendConsentDecision(tx, decision(invitation.id)))
    expect(row).not.toBeNull()
    expect(row?.purpose).toBe('terms_and_privacy')
    expect(row?.withdrawnAt).toBeNull()
    // The audit witness stays in the table; it is not part of any DTO.
    expect(row).not.toHaveProperty('requestEvidenceHash')
  })

  it('is idempotent: the same act of consent submitted twice yields one row', async () => {
    const invitation = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    const first = await db.transaction((tx) => appendConsentDecision(tx, decision(invitation.id)))
    const second = await db.transaction((tx) => appendConsentDecision(tx, decision(invitation.id)))
    expect(second?.id).toBe(first?.id)
    const all = await db.transaction((tx) => listConsentsForInvitation(tx, ORG_A, invitation.id))
    expect(all).toHaveLength(1)
  })

  it('records a changed decision as a new row rather than editing the old one', async () => {
    const invitation = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    const declined = await db.transaction((tx) => appendConsentDecision(tx, decision(invitation.id, {
      purpose: 'live_audio_transcription',
      decision: 'declined',
    })))
    const accepted = await db.transaction((tx) => appendConsentDecision(tx, decision(invitation.id, {
      purpose: 'live_audio_transcription',
      decision: 'accepted',
      supersedesId: declined?.id,
    })))

    const all = await db.transaction((tx) => listConsentsForInvitation(tx, ORG_A, invitation.id))
    expect(all).toHaveLength(2)
    // The superseded decline is still on file: it is evidence of what the candidate was asked and
    // answered at that moment, not a draft.
    expect(all.find((row) => row.id === declined?.id)?.decision).toBe('declined')
    expect(all.find((row) => row.id === accepted?.id)?.supersedesId).toBe(declined?.id)
  })

  it('finds receipts by id only within their own invitation', async () => {
    const mine = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    const other = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    const receipt = await db.transaction((tx) => appendConsentDecision(tx, decision(mine.id)))

    const found = await db.transaction((tx) => findConsentsByIds(tx, ORG_A, mine.id, [receipt!.id]))
    expect(found).toHaveLength(1)

    // A receipt legitimately earned under one invitation must not satisfy another one.
    const replayed = await db.transaction((tx) => findConsentsByIds(tx, ORG_A, other.id, [receipt!.id]))
    expect(replayed).toHaveLength(0)
  })

  it('withdraws a live grant once and reports nothing to withdraw the second time', async () => {
    const invitation = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    await db.transaction((tx) => appendConsentDecision(tx, decision(invitation.id, { purpose: 'ai_interview_assistance' })))

    const withdrawnAt = new Date('2026-08-01T10:00:00.000Z')
    const first = await db.transaction((tx) => withdrawConsent(tx, ORG_A, invitation.id, 'ai_interview_assistance', withdrawnAt))
    expect(first?.withdrawnAt?.toISOString()).toBe(withdrawnAt.toISOString())

    const second = await db.transaction((tx) => withdrawConsent(tx, ORG_A, invitation.id, 'ai_interview_assistance', new Date()))
    expect(second).toBeNull()
  })

  it('will not withdraw a purpose that was declined rather than granted', async () => {
    const invitation = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    await db.transaction((tx) => appendConsentDecision(tx, decision(invitation.id, {
      purpose: 'public_web_import',
      decision: 'declined',
    })))
    expect(await db.transaction((tx) => withdrawConsent(tx, ORG_A, invitation.id, 'public_web_import', new Date()))).toBeNull()
  })

  it('rejects a withdrawal timestamp on a declined decision at the database level', async () => {
    // The guard is a table check, not service logic: a declined purpose was never granted, so a
    // `withdrawn_at` on it would read back as "accepted, then revoked" and invert the record.
    const invitation = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    const rejection = await db.insert(privacyConsents).values({
      organizationId: ORG_A,
      invitationId: invitation.id,
      subjectEmailHash: hashOf('candidate@test.invalid'),
      purpose: 'public_web_import',
      noticeVersion: '2026-07-01',
      decision: 'declined',
      withdrawnAt: new Date(),
      requestEvidenceHash: hashOf('evidence'),
    }).then(() => null, (error: unknown) => error)

    // drizzle wraps the driver error, so the constraint name is on the cause, not the message.
    expect(rejection).not.toBeNull()
    expect((rejection as { cause?: { constraint_name?: string } }).cause?.constraint_name)
      .toBe('privacy_consents_withdrawal_check')
  })

  it('never returns another tenant consent rows', async () => {
    const invitation = await db.transaction((tx) => insertInvitation(tx, invitationInput()))
    await db.transaction((tx) => appendConsentDecision(tx, decision(invitation.id)))
    expect(await db.transaction((tx) => listConsentsForInvitation(tx, ORG_B, invitation.id))).toHaveLength(0)
  })
})
