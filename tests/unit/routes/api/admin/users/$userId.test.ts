import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  requireRecentPlatformAdminAuthentication: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  setUserPlan: vi.fn(),
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

vi.mock('~/shared/lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing')>()
  return { ...actual, setUserPlan: mocks.setUserPlan }
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
  mocks.setUserPlan.mockResolvedValue({ from: 'free', to: 'pro' })
})

describe('PATCH /api/admin/users/$userId', () => {
  it('rejects a non-admin before granting anything', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))
    const response = await callPatch()
    expect(response.status).toBe(403)
    expect(mocks.setUserPlan).not.toHaveBeenCalled()
  })

  it('requires recent authentication before granting a manual exception', async () => {
    mocks.requireRecentPlatformAdminAuthentication.mockImplementation(() => {
      throw new PlatformAdminAuthorizationError('Recent re-authentication required', 401)
    })
    const response = await callPatch()
    expect(response.status).toBe(401)
    expect(mocks.setUserPlan).not.toHaveBeenCalled()
  })

  it('never accepts pro_max — Stripe-only, not manually grantable', async () => {
    const response = await callPatch({ plan: 'pro_max', reason: 'test' })
    expect(response.status).toBe(400)
    expect(mocks.setUserPlan).not.toHaveBeenCalled()
  })

  it('grants a plan and audits the mutation', async () => {
    const response = await callPatch({ plan: 'pro', reason: 'paid via bank transfer' })
    expect(response.status).toBe(200)
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.user.plan-change', targetId: 'u-1' }),
    )
  })
})
