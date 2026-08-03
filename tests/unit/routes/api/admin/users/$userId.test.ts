import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  requireRecentPlatformAdminAuthentication: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  getPlatformUserBillingSummary: vi.fn(),
  grantOrganizationEntitlement: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return {
    ...actual,
    requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal,
    requireRecentPlatformAdminAuthentication: mocks.requireRecentPlatformAdminAuthentication,
    auditPlatformAdminAction: mocks.auditPlatformAdminAction,
  }
})

/**
 * The grant moved from the per-**user** `plans` table to the per-**organization** entitlement
 * (`operator-grants.ts`), so these mocks follow it: the route now resolves which organization the user owns
 * before it can grant anything. `setUserPlan` is gone.
 */
vi.mock('~/shared/lib/repositories/platform-billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/platform-billing')>()
  return { ...actual, getPlatformUserBillingSummary: mocks.getPlatformUserBillingSummary }
})

vi.mock('~/shared/lib/repositories/operator-grants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/operator-grants')>()
  return { ...actual, grantOrganizationEntitlement: mocks.grantOrganizationEntitlement }
})

const { Route } = await import('~/routes/api/admin/users/$userId')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

function patchRequest(body: unknown): Request {
  return new Request('https://app.test/api/admin/users/u-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callPatch(body: unknown = { plan: 'pro', reason: 'test' }): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { PATCH: (args: { request: Request; params: { userId: string } }) => Promise<Response> } } } }).options.server.handlers.PATCH
  return handler({ request: patchRequest(body), params: { userId: 'u-1' } })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
  mocks.getPlatformUserBillingSummary.mockResolvedValue({
    organizationId: 'org-1', organizationName: 'Acme', entitlementTier: 'free', entitlementStatus: 'active',
    currentPeriodEnd: null, trialEndsAt: null, provenance: 'canonical', hasActiveSubscription: false,
  })
  mocks.grantOrganizationEntitlement.mockResolvedValue({
    organizationId: 'org-1', tier: 'pro', status: 'active', seatLimit: 1, notes: null, trialEndsAt: null,
  })
})

describe('PATCH /api/admin/users/$userId', () => {
  it('rejects a non-admin before granting anything', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))
    const response = await callPatch()
    expect(response.status).toBe(403)
    expect(mocks.grantOrganizationEntitlement).not.toHaveBeenCalled()
  })

  it('requires recent authentication before granting a manual exception', async () => {
    mocks.requireRecentPlatformAdminAuthentication.mockImplementation(() => {
      throw new PlatformAdminAuthorizationError('Recent re-authentication required', 401)
    })
    const response = await callPatch()
    expect(response.status).toBe(401)
    expect(mocks.grantOrganizationEntitlement).not.toHaveBeenCalled()
  })

  it('never accepts pro_max — Stripe-only, not manually grantable', async () => {
    const response = await callPatch({ plan: 'pro_max', reason: 'test' })
    expect(response.status).toBe(400)
    expect(mocks.grantOrganizationEntitlement).not.toHaveBeenCalled()
  })

  it('grants against the organization the user owns, and audits that subject', async () => {
    /**
     * Both the action name and the audit *target* changed, and the target is the substance.
     *
     * This asserted `action: 'admin.user.plan-change'` with `targetId: 'u-1'` — the user. Entitlement is
     * enforced per organization, so an audit row naming a user records something no enforcement check ever
     * reads: it cannot answer "which workspace got upgraded", which is the only question an auditor has.
     *
     * The row now targets the organization and carries `onBehalfOfUserId` so both ends of the indirection
     * survive — the operator clicked a user, the entitlement moved on a workspace.
     */
    const response = await callPatch({ plan: 'pro', reason: 'paid via bank transfer' })
    expect(response.status).toBe(200)

    expect(mocks.grantOrganizationEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', tier: 'pro', notes: 'paid via bank transfer' }),
    )
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({
        action: 'admin.user.entitlement-grant',
        targetType: 'organization',
        targetId: 'org-1',
        details: expect.objectContaining({ from: 'free', to: 'pro', onBehalfOfUserId: 'u-1' }),
      }),
    )
  })

  it('refuses a user who owns no organization instead of granting into nothing', async () => {
    /**
     * The legacy path wrote a `plans` row for such a user quite happily, and that row then applied to no
     * workspace at all — an entitlement invisible to every enforcement check, which looks like a successful
     * grant to the operator and does nothing for the customer.
     */
    mocks.getPlatformUserBillingSummary.mockResolvedValue(null)
    const response = await callPatch({ plan: 'pro', reason: 'test' })

    expect(response.status).toBe(409)
    expect(mocks.grantOrganizationEntitlement).not.toHaveBeenCalled()
    // The refusal is audited too: an operator attempt that changed nothing is still an attempt.
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ result: 'denied', details: expect.objectContaining({ reason: 'no_organization' }) }),
    )
  })
})
