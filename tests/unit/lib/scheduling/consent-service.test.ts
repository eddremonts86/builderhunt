import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations } from '~/shared/lib/db/schema'
import { insertInvitation, listConsentsForInvitation } from '~/shared/lib/repositories/scheduling'
import { hashCapability } from '~/lib/scheduling/capability'
import {
  hashConsentSubject,
  recordDecisions,
  verifyRequiredConsents,
  withdrawPurpose,
} from '~/lib/scheduling/consent-service'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'consent-org'
const OWNER = 'consent-owner'
const NOTICE = '2026-07-01'
const EMAIL = 'candidate@test.invalid'

let invitationCounter = 0
async function newInvitation() {
  invitationCounter += 1
  return db.transaction((tx) => insertInvitation(tx, {
    organizationId: ORG,
    ownerUserId: OWNER,
    roleTitle: 'Engineer',
    roleContext: 'Platform',
    durationMinutes: 45,
    timezone: 'Europe/Copenhagen',
    modality: 'remote_call',
    capabilityHash: hashCapability(`consent-secret-${invitationCounter}`),
    policyVersion: 'v1',
  }))
}

function recordInput(invitationId: string, decisions: Parameters<typeof recordDecisions>[1]['decisions']) {
  return {
    organizationId: ORG,
    invitationId,
    subjectEmail: EMAIL,
    noticeVersion: NOTICE,
    decisions,
    requestFingerprint: 'test-fingerprint',
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('scheduling_consent_service')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Consent', slug: 'consent-org' })
  await db.insert(authUsers).values({
    id: OWNER, name: 'Owner', email: 'consent-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('consent subject hashing', () => {
  it('treats the same address typed differently as one subject', () => {
    expect(hashConsentSubject('A@B.dk')).toBe(hashConsentSubject('  a@b.dk '))
  })

  it('keeps different addresses apart and never returns the address', () => {
    const hash = hashConsentSubject(EMAIL)
    expect(hash).not.toBe(hashConsentSubject('other@test.invalid'))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('candidate')
  })

  it('is domain-separated from the capability hash of the same input', async () => {
    // Two hashes of the same string in the same codebase must not be interchangeable.
    expect(hashConsentSubject(EMAIL)).not.toBe(hashCapability(EMAIL))
  })
})

describe('recording decisions', () => {
  it('appends one receipt per individual decision', async () => {
    const invitation = await newInvitation()
    const result = await db.transaction((tx) => recordDecisions(tx, recordInput(invitation.id, [
      { purpose: 'terms_and_privacy', decision: 'accepted' },
      { purpose: 'live_audio_transcription', decision: 'declined' },
    ])))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipts).toHaveLength(2)
    expect(result.receipts.map((r) => r.purpose).sort())
      .toEqual(['live_audio_transcription', 'terms_and_privacy'])
  })

  it('rejects an empty decision list', async () => {
    const invitation = await newInvitation()
    const result = await db.transaction((tx) => recordDecisions(tx, recordInput(invitation.id, [])))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid_input')
  })

  it('rejects two conflicting answers to the same question', async () => {
    // Guessing which one the candidate meant is not a decision this code gets to make.
    const invitation = await newInvitation()
    const result = await db.transaction((tx) => recordDecisions(tx, recordInput(invitation.id, [
      { purpose: 'terms_and_privacy', decision: 'accepted' },
      { purpose: 'terms_and_privacy', decision: 'declined' },
    ])))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('duplicate')
  })

  it('links a changed answer to the decision it replaces, keeping both', async () => {
    const invitation = await newInvitation()
    const declined = await db.transaction((tx) => recordDecisions(tx, recordInput(invitation.id, [
      { purpose: 'ai_interview_assistance', decision: 'declined' },
    ])))
    const accepted = await db.transaction((tx) => recordDecisions(tx, recordInput(invitation.id, [
      { purpose: 'ai_interview_assistance', decision: 'accepted' },
    ])))
    expect(declined.ok && accepted.ok).toBe(true)

    const ledger = await db.transaction((tx) => listConsentsForInvitation(tx, ORG, invitation.id))
    expect(ledger).toHaveLength(2)
    const acceptedRow = ledger.find((row) => row.decision === 'accepted')
    const declinedRow = ledger.find((row) => row.decision === 'declined')
    expect(acceptedRow?.supersedesId).toBe(declinedRow?.id)
  })

  it('is idempotent under a double-submitted form', async () => {
    const invitation = await newInvitation()
    const input = recordInput(invitation.id, [{ purpose: 'terms_and_privacy', decision: 'accepted' }])
    const first = await db.transaction((tx) => recordDecisions(tx, input))
    const second = await db.transaction((tx) => recordDecisions(tx, input))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.receipts[0]?.id).toBe(first.receipts[0]?.id)
    expect(await db.transaction((tx) => listConsentsForInvitation(tx, ORG, invitation.id))).toHaveLength(1)
  })
})

describe('verifying required consents at booking', () => {
  async function acceptAll(invitationId: string, purposes: Parameters<typeof verifyRequiredConsents>[1]['requiredPurposes']) {
    const result = await db.transaction((tx) => recordDecisions(tx, recordInput(
      invitationId,
      purposes.map((purpose) => ({ purpose, decision: 'accepted' as const })),
    )))
    if (!result.ok) throw new Error(result.reason)
    return result.receipts.map((receipt) => receipt.id)
  }

  it('passes when every required purpose has a live accepted receipt', async () => {
    const invitation = await newInvitation()
    const required = ['terms_and_privacy', 'live_audio_transcription'] as const
    const ids = await acceptAll(invitation.id, required)

    const result = await db.transaction((tx) => verifyRequiredConsents(tx, {
      organizationId: ORG,
      invitationId: invitation.id,
      consentReceiptIds: ids,
      requiredPurposes: required,
      noticeVersion: NOTICE,
    }))
    expect(result.ok).toBe(true)
  })

  it('names exactly the purposes that are missing', async () => {
    const invitation = await newInvitation()
    const ids = await acceptAll(invitation.id, ['terms_and_privacy'])

    const result = await db.transaction((tx) => verifyRequiredConsents(tx, {
      organizationId: ORG,
      invitationId: invitation.id,
      consentReceiptIds: ids,
      requiredPurposes: ['terms_and_privacy', 'candidate_document_processing'],
      noticeVersion: NOTICE,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('consent_required')
    expect(result.missingPurposes).toEqual(['candidate_document_processing'])
  })

  it('does not accept a declined receipt as consent', async () => {
    const invitation = await newInvitation()
    const recorded = await db.transaction((tx) => recordDecisions(tx, recordInput(invitation.id, [
      { purpose: 'terms_and_privacy', decision: 'declined' },
    ])))
    if (!recorded.ok) throw new Error(recorded.reason)

    const result = await db.transaction((tx) => verifyRequiredConsents(tx, {
      organizationId: ORG,
      invitationId: invitation.id,
      consentReceiptIds: recorded.receipts.map((r) => r.id),
      requiredPurposes: ['terms_and_privacy'],
      noticeVersion: NOTICE,
    }))
    expect(result.ok).toBe(false)
  })

  it('does not accept a receipt issued against an older notice version', async () => {
    // The candidate consented to what that version said, not to whatever it says today.
    const invitation = await newInvitation()
    const ids = await acceptAll(invitation.id, ['terms_and_privacy'])

    const result = await db.transaction((tx) => verifyRequiredConsents(tx, {
      organizationId: ORG,
      invitationId: invitation.id,
      consentReceiptIds: ids,
      requiredPurposes: ['terms_and_privacy'],
      noticeVersion: '2026-09-01',
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missingPurposes).toEqual(['terms_and_privacy'])
  })

  it('does not accept a withdrawn grant', async () => {
    const invitation = await newInvitation()
    const ids = await acceptAll(invitation.id, ['terms_and_privacy'])
    await db.transaction((tx) => withdrawPurpose(tx, {
      organizationId: ORG, invitationId: invitation.id, purpose: 'terms_and_privacy',
    }))

    const result = await db.transaction((tx) => verifyRequiredConsents(tx, {
      organizationId: ORG,
      invitationId: invitation.id,
      consentReceiptIds: ids,
      requiredPurposes: ['terms_and_privacy'],
      noticeVersion: NOTICE,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('consent_required')
  })

  it('does not accept a receipt earned under a different invitation', async () => {
    const mine = await newInvitation()
    const other = await newInvitation()
    const ids = await acceptAll(other.id, ['terms_and_privacy'])

    const result = await db.transaction((tx) => verifyRequiredConsents(tx, {
      organizationId: ORG,
      invitationId: mine.id,
      consentReceiptIds: ids,
      requiredPurposes: ['terms_and_privacy'],
      noticeVersion: NOTICE,
    }))
    expect(result.ok).toBe(false)
  })

  it('does not accept consent that is on file but was not presented', async () => {
    // Consent has to be asserted by the booking request, not merely exist somewhere.
    const invitation = await newInvitation()
    await acceptAll(invitation.id, ['terms_and_privacy'])

    const result = await db.transaction((tx) => verifyRequiredConsents(tx, {
      organizationId: ORG,
      invitationId: invitation.id,
      consentReceiptIds: [],
      requiredPurposes: ['terms_and_privacy'],
      noticeVersion: NOTICE,
    }))
    expect(result.ok).toBe(false)
  })
})

describe('withdrawal', () => {
  it('stamps the grant without removing it', async () => {
    const invitation = await newInvitation()
    await db.transaction((tx) => recordDecisions(tx, recordInput(invitation.id, [
      { purpose: 'live_audio_transcription', decision: 'accepted' },
    ])))

    const result = await db.transaction((tx) => withdrawPurpose(tx, {
      organizationId: ORG, invitationId: invitation.id, purpose: 'live_audio_transcription',
    }))
    expect(result.withdrawn).toBe(true)
    expect(result.withdrawnAt).not.toBeNull()

    // Past processing was lawful; the evidence of that survives the withdrawal.
    const ledger = await db.transaction((tx) => listConsentsForInvitation(tx, ORG, invitation.id))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.decision).toBe('accepted')
    expect(ledger[0]?.withdrawnAt).not.toBeNull()
  })

  it('withdrawing twice is not an error', async () => {
    const invitation = await newInvitation()
    await db.transaction((tx) => recordDecisions(tx, recordInput(invitation.id, [
      { purpose: 'public_web_import', decision: 'accepted' },
    ])))
    const args = { organizationId: ORG, invitationId: invitation.id, purpose: 'public_web_import' } as const
    expect((await db.transaction((tx) => withdrawPurpose(tx, args))).withdrawn).toBe(true)
    expect((await db.transaction((tx) => withdrawPurpose(tx, args))).withdrawn).toBe(false)
  })

  it('reports nothing withdrawn for a purpose that was never granted', async () => {
    const invitation = await newInvitation()
    const result = await db.transaction((tx) => withdrawPurpose(tx, {
      organizationId: ORG, invitationId: invitation.id, purpose: 'candidate_document_processing',
    }))
    expect(result.withdrawn).toBe(false)
  })
})
