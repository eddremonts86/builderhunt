import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  listExpiredPendingDeletionRequests: vi.fn(),
  hardDeleteAccountSubject: vi.fn(),
  listOwnedOrganizations: vi.fn(),
  updateDeletionRequest: vi.fn(),
  loadAccountExportSource: vi.fn(),
  findAccountEmail: vi.fn(),
  sendDeletionCompletedEmail: vi.fn(),
}))

vi.mock('~/shared/lib/repositories/account-privacy', () => ({
  listExpiredPendingDeletionRequests: mocks.listExpiredPendingDeletionRequests,
  hardDeleteAccountSubject: mocks.hardDeleteAccountSubject,
  listOwnedOrganizations: mocks.listOwnedOrganizations,
  updateDeletionRequest: mocks.updateDeletionRequest,
  loadAccountExportSource: mocks.loadAccountExportSource,
  findAccountEmail: mocks.findAccountEmail,
  cancelPendingDeletion: vi.fn(),
  findDeletionRequest: vi.fn(),
  insertAccountConsent: vi.fn(),
  insertDeletionRequest: vi.fn(),
  listAccountConsents: vi.fn(),
}))

vi.mock('~/shared/lib/email', () => ({
  sendDeletionCompletedEmail: mocks.sendDeletionCompletedEmail,
}))

import {
  CURRENT_CONSENT_VERSIONS,
  GRACE_PERIOD_MS,
  EXPORT_TTL_MS,
  buildExportPayload,
  processPendingDeletions,
  type ConsentDocument,
} from './legal'

describe('legal constants', () => {
  it('has current versions for all required documents', () => {
    expect(CURRENT_CONSENT_VERSIONS.tos).toBe('v1.0')
    expect(CURRENT_CONSENT_VERSIONS.privacy).toBe('v1.0')
    expect(CURRENT_CONSENT_VERSIONS.cookies).toBe('v1.0')
  })

  it('grace period is exactly 30 days in ms', () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    expect(GRACE_PERIOD_MS).toBe(thirtyDays)
  })

  it('export TTL is exactly 7 days in ms', () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(EXPORT_TTL_MS).toBe(sevenDays)
  })

  it('ConsentDocument union covers tos/privacy/cookies', () => {
    const docs: ConsentDocument[] = ['tos', 'privacy', 'cookies']
    expect(docs).toHaveLength(3)
  })
})

describe('processPendingDeletions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listOwnedOrganizations.mockResolvedValue([])
    mocks.findAccountEmail.mockResolvedValue(null)
    mocks.sendDeletionCompletedEmail.mockResolvedValue({ ok: true })
  })

  it('hard-deletes every due subject and marks each request completed', async () => {
    mocks.listExpiredPendingDeletionRequests.mockResolvedValue([
      { id: 'req-1', userId: 'user-1' },
      { id: 'req-2', userId: 'user-2' },
    ])

    const result = await processPendingDeletions()

    expect(result).toEqual({ processed: 2, errors: 0 })
    expect(mocks.hardDeleteAccountSubject).toHaveBeenCalledWith('user-1')
    expect(mocks.hardDeleteAccountSubject).toHaveBeenCalledWith('user-2')
    expect(mocks.updateDeletionRequest).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ status: 'completed', completedAt: expect.any(Date) }),
    )
    expect(mocks.updateDeletionRequest).toHaveBeenCalledWith(
      'req-2',
      expect.objectContaining({ status: 'completed', completedAt: expect.any(Date) }),
    )
  })

  it('captures the email before hard-deleting, then sends the deletion-completed notice', async () => {
    mocks.listExpiredPendingDeletionRequests.mockResolvedValue([{ id: 'req-1', userId: 'user-1' }])
    mocks.findAccountEmail.mockResolvedValue('ada@example.com')
    const callOrder: string[] = []
    mocks.findAccountEmail.mockImplementation(async () => { callOrder.push('findAccountEmail'); return 'ada@example.com' })
    mocks.hardDeleteAccountSubject.mockImplementation(async () => { callOrder.push('hardDeleteAccountSubject') })
    mocks.sendDeletionCompletedEmail.mockImplementation(async () => { callOrder.push('sendDeletionCompletedEmail'); return { ok: true } })

    const result = await processPendingDeletions()

    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(mocks.findAccountEmail).toHaveBeenCalledWith('user-1')
    expect(mocks.sendDeletionCompletedEmail).toHaveBeenCalledWith('ada@example.com')
    // The email must be looked up BEFORE the hard delete removes the row it lives on.
    expect(callOrder).toEqual(['findAccountEmail', 'hardDeleteAccountSubject', 'sendDeletionCompletedEmail'])
  })

  it('does not send an email and does not fail the batch when no email was found', async () => {
    mocks.listExpiredPendingDeletionRequests.mockResolvedValue([{ id: 'req-1', userId: 'user-1' }])
    mocks.findAccountEmail.mockResolvedValue(null)

    const result = await processPendingDeletions()

    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(mocks.sendDeletionCompletedEmail).not.toHaveBeenCalled()
  })

  it('a failed completion email does not undo the completed deletion or count as an error', async () => {
    mocks.listExpiredPendingDeletionRequests.mockResolvedValue([{ id: 'req-1', userId: 'user-1' }])
    mocks.findAccountEmail.mockResolvedValue('ada@example.com')
    mocks.sendDeletionCompletedEmail.mockRejectedValueOnce(new Error('resend down'))

    const result = await processPendingDeletions()

    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(mocks.updateDeletionRequest).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ status: 'completed' }),
    )
  })

  it('is a no-op when nothing is due — idempotent re-run', async () => {
    mocks.listExpiredPendingDeletionRequests.mockResolvedValue([])

    const result = await processPendingDeletions()

    expect(result).toEqual({ processed: 0, errors: 0 })
    expect(mocks.hardDeleteAccountSubject).not.toHaveBeenCalled()
    expect(mocks.updateDeletionRequest).not.toHaveBeenCalled()
  })

  it('counts a failed hard delete as an error and leaves that request untouched', async () => {
    mocks.listExpiredPendingDeletionRequests.mockResolvedValue([{ id: 'req-1', userId: 'user-1' }])
    mocks.hardDeleteAccountSubject.mockRejectedValueOnce(new Error('db unavailable'))

    const result = await processPendingDeletions()

    expect(result).toEqual({ processed: 0, errors: 1 })
    expect(mocks.updateDeletionRequest).not.toHaveBeenCalled()
  })

  it('still deletes the account subject if it currently owns organizations, honoring the request-time invariant', async () => {
    // requestDeletion() already refuses new requests while organizations are owned; if
    // ownership changed after the request was created, performHardDelete would throw and
    // the request should be retried on the next run rather than silently skipped.
    mocks.listExpiredPendingDeletionRequests.mockResolvedValue([{ id: 'req-1', userId: 'user-1' }])
    mocks.listOwnedOrganizations.mockResolvedValue([{ organizationId: 'org-1' }])

    const result = await processPendingDeletions()

    expect(result).toEqual({ processed: 0, errors: 1 })
    expect(mocks.hardDeleteAccountSubject).not.toHaveBeenCalled()
    expect(mocks.updateDeletionRequest).not.toHaveBeenCalled()
  })
})

describe('buildExportPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when the account subject cannot be found', async () => {
    mocks.loadAccountExportSource.mockResolvedValue(null)

    const result = await buildExportPayload('missing-user')

    expect(result).toBeNull()
  })

  it('surfaces trackedBuilders/plan/planChanges/planRequests as top-level payload keys', async () => {
    mocks.loadAccountExportSource.mockResolvedValue({
      user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
      auth: null,
      consents: [],
      claimRequests: [],
      claims: [],
      profileViews: [],
      deletion: null,
      organizationMemberships: [],
      trackedBuilders: [{ id: 'builder-1', source: 'github', username: 'ada' }],
      plan: { plan: 'pro', status: 'active' },
      planChanges: [{ id: 'change-1', fromPlan: 'free', toPlan: 'pro' }],
      planRequests: [{ id: 'request-1', requestedPlan: 'team', status: 'pending' }],
    })

    const result = await buildExportPayload('user-1')

    expect(result).not.toBeNull()
    expect(Object.keys(result!)).toEqual(
      expect.arrayContaining(['trackedBuilders', 'plan', 'planChanges', 'planRequests', 'accountSubject', 'exportedAt']),
    )
    expect(result!.trackedBuilders).toEqual([{ id: 'builder-1', source: 'github', username: 'ada' }])
    expect(result!.plan).toEqual({ plan: 'pro', status: 'active' })
    expect(result!.planChanges).toEqual([{ id: 'change-1', fromPlan: 'free', toPlan: 'pro' }])
    expect(result!.planRequests).toEqual([{ id: 'request-1', requestedPlan: 'team', status: 'pending' }])
    // The account-subject-only fields stay nested, not duplicated at the top level.
    expect(result!.accountSubject).not.toHaveProperty('trackedBuilders')
    expect(result!.accountSubject.user).toEqual({ id: 'user-1', name: 'Ada', email: 'ada@example.com' })
  })
})
