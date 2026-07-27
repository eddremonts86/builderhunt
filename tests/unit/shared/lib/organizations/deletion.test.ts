import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requestOrganizationDeletion: vi.fn(),
  cancelOrganizationDeletion: vi.fn(),
  hardDeleteOrganization: vi.fn(),
  withTenantContext: vi.fn(),
  cancelSubscriptionAtPeriodEnd: vi.fn(),
  cancelSubscriptionImmediately: vi.fn(),
  findOrganizationName: vi.fn(),
  findFullActiveBillingSubscription: vi.fn(),
  findBillingCustomer: vi.fn(),
  withWorkerOrganization: vi.fn(),
  emitSecurityAudit: vi.fn(),
}))

vi.mock('~/shared/lib/auth/organization-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/organization-lifecycle')>()
  return {
    ...actual,
    getOrganizationLifecycle: async () => ({
      requestOrganizationDeletion: mocks.requestOrganizationDeletion,
      cancelOrganizationDeletion: mocks.cancelOrganizationDeletion,
    }),
    hardDeleteOrganization: mocks.hardDeleteOrganization,
  }
})

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/billing/subscription-changes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/subscription-changes')>()
  return {
    ...actual,
    cancelSubscriptionAtPeriodEnd: mocks.cancelSubscriptionAtPeriodEnd,
    cancelSubscriptionImmediately: mocks.cancelSubscriptionImmediately,
  }
})

vi.mock('~/shared/lib/repositories/account-privacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/account-privacy')>()
  return { ...actual, findOrganizationName: mocks.findOrganizationName }
})

vi.mock('~/shared/lib/repositories/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing')>()
  return {
    ...actual,
    findFullActiveBillingSubscription: mocks.findFullActiveBillingSubscription,
    findBillingCustomer: mocks.findBillingCustomer,
  }
})

vi.mock('~/shared/lib/repositories/billing-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing-worker')>()
  return { ...actual, withWorkerOrganization: mocks.withWorkerOrganization }
})

vi.mock('~/shared/lib/security/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/security/audit')>()
  return { ...actual, emitSecurityAudit: mocks.emitSecurityAudit }
})

const { requestNormalDeletion, requestImmediateDeletion, finalizeOrganizationDeletion, OrganizationDeletionError } = await import('~/shared/lib/organizations/deletion')
const { SubscriptionChangeError } = await import('~/shared/lib/billing/subscription-changes')

function principal(overrides: Partial<TenantPrincipal> = {}): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role: 'owner', requestId: 'request-1', ...overrides }
}

const provider = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, fn: (tx: unknown) => unknown) => fn({}))
  mocks.withWorkerOrganization.mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn({ insert: () => ({ values: vi.fn() }) }))
  mocks.findOrganizationName.mockResolvedValue('Acme Inc')
  mocks.findFullActiveBillingSubscription.mockResolvedValue(null)
  mocks.findBillingCustomer.mockResolvedValue(null)
  mocks.hardDeleteOrganization.mockResolvedValue(undefined)
})

describe('requestNormalDeletion', () => {
  it('delegates to the existing scheduled-request lifecycle call and returns its result', async () => {
    mocks.requestOrganizationDeletion.mockResolvedValue({ id: 'req-1', gracePeriodEndsAt: new Date('2026-08-01T00:00:00Z') })
    mocks.cancelSubscriptionAtPeriodEnd.mockResolvedValue({ cancelAtPeriodEnd: true, effectiveAt: '2026-08-01T00:00:00Z' })

    const result = await requestNormalDeletion(new Request('https://app.test'), principal(), { provider })

    expect(result.id).toBe('req-1')
    expect(result.gracePeriodEndsAt).toEqual(new Date('2026-08-01T00:00:00Z'))
    expect(mocks.cancelSubscriptionAtPeriodEnd).toHaveBeenCalled()
  })

  it('is a no-op, not a failure, when the organization has no active subscription', async () => {
    mocks.requestOrganizationDeletion.mockResolvedValue({ id: 'req-1', gracePeriodEndsAt: new Date('2026-08-01T00:00:00Z') })
    mocks.cancelSubscriptionAtPeriodEnd.mockRejectedValue(new SubscriptionChangeError('No active subscription for this organization', 'no_active_subscription'))

    const result = await requestNormalDeletion(new Request('https://app.test'), principal(), { provider })

    expect(result.id).toBe('req-1') // the deletion request itself still succeeded
  })

  it('still succeeds the deletion request even if the best-effort billing cancel throws unexpectedly', async () => {
    mocks.requestOrganizationDeletion.mockResolvedValue({ id: 'req-1', gracePeriodEndsAt: new Date('2026-08-01T00:00:00Z') })
    mocks.cancelSubscriptionAtPeriodEnd.mockRejectedValue(new Error('boom'))

    const result = await requestNormalDeletion(new Request('https://app.test'), principal(), { provider })

    expect(result.id).toBe('req-1')
  })
})

describe('requestImmediateDeletion', () => {
  const freshSession = { authenticatedAt: new Date('2026-06-01T00:00:00Z') }
  const now = () => new Date('2026-06-01T00:05:00Z') // 5 minutes later — within the 15-minute window

  it('rejects a non-owner before touching any billing/deletion logic', async () => {
    await expect(requestImmediateDeletion(principal({ role: 'admin' }), freshSession, { provider, now }))
      .rejects.toMatchObject({ status: 403 })
    expect(mocks.findOrganizationName).not.toHaveBeenCalled()
  })

  it('rejects a missing session with a stale-session 401', async () => {
    await expect(requestImmediateDeletion(principal(), undefined, { provider, now }))
      .rejects.toMatchObject({ status: 401 })
  })

  it('rejects a session older than the recent-auth window', async () => {
    const staleSession = { authenticatedAt: new Date('2026-06-01T00:00:00Z') }
    const laterNow = () => new Date('2026-06-01T00:20:00Z') // 20 minutes later — past the 15-minute window
    await expect(requestImmediateDeletion(principal(), staleSession, { provider, now: laterNow }))
      .rejects.toMatchObject({ status: 401 })
    expect(mocks.findOrganizationName).not.toHaveBeenCalled()
  })

  it('an owner with a fresh session finalizes the deletion and audits it', async () => {
    const result = await requestImmediateDeletion(principal(), freshSession, { provider, now })

    expect(result).toEqual({ requestId: 'request-1' })
    expect(mocks.findOrganizationName).toHaveBeenCalledWith('org-a')
    expect(mocks.hardDeleteOrganization).toHaveBeenCalledWith('org-a')
    expect(mocks.emitSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'organization.delete.immediate', organizationId: 'org-a', result: 'allowed' }),
      expect.anything(),
    )
  })

  it('surfaces OrganizationDeletionError as an actual instance callers can catch', async () => {
    try {
      await requestImmediateDeletion(principal({ role: 'member' }), freshSession, { provider, now })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(OrganizationDeletionError)
    }
  })
})

describe('finalizeOrganizationDeletion', () => {
  it('is idempotent — a no-op when the organization is already gone', async () => {
    mocks.findOrganizationName.mockResolvedValue(null)

    await finalizeOrganizationDeletion('org-gone', 'scheduled', { provider })

    expect(mocks.withWorkerOrganization).not.toHaveBeenCalled()
    expect(mocks.hardDeleteOrganization).not.toHaveBeenCalled()
  })

  it('force-cancels a still-active subscription and writes a financial snapshot before hard-deleting', async () => {
    mocks.findFullActiveBillingSubscription.mockResolvedValue({ tier: 'team', interval: 'annual', stripeSubscriptionId: 'sub_1' })
    mocks.findBillingCustomer.mockResolvedValue({ stripeCustomerId: 'cus_1' })
    mocks.cancelSubscriptionImmediately.mockResolvedValue({ canceled: true, canceledAt: '2026-06-01T00:00:00.000Z' })
    const insertValues = vi.fn()
    mocks.withWorkerOrganization.mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) =>
      fn({ insert: () => ({ values: insertValues }) }),
    )

    await finalizeOrganizationDeletion('org-a', 'immediate', { provider })

    expect(mocks.cancelSubscriptionImmediately).toHaveBeenCalledWith(expect.anything(), 'org-a', { provider })
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a',
      organizationName: 'Acme Inc',
      deletionType: 'immediate',
      stripeCustomerId: 'cus_1',
      lastSubscriptionTier: 'team',
      lastSubscriptionInterval: 'annual',
    }))
    expect(mocks.hardDeleteOrganization).toHaveBeenCalledWith('org-a')
  })

  it('writes a snapshot with null subscription fields for a free-tier organization — never fails or skips retention', async () => {
    const insertValues = vi.fn()
    mocks.withWorkerOrganization.mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) =>
      fn({ insert: () => ({ values: insertValues }) }),
    )

    await finalizeOrganizationDeletion('org-free', 'scheduled', { provider })

    expect(mocks.cancelSubscriptionImmediately).not.toHaveBeenCalled()
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-free',
      lastSubscriptionTier: null,
      lastSubscriptionInterval: null,
      subscriptionCanceledAt: null,
    }))
    expect(mocks.hardDeleteOrganization).toHaveBeenCalledWith('org-free')
  })
})
