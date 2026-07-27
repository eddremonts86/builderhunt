import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  findPlanRequest: vi.fn(),
  listPlanRequestsWithUsers: vi.fn(),
  resolvePlanRequest: vi.fn(),
  setUserPlan: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal, auditPlatformAdminAction: mocks.auditPlatformAdminAction }
})

vi.mock('~/shared/lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing')>()
  return {
    ...actual,
    findPlanRequest: mocks.findPlanRequest,
    listPlanRequestsWithUsers: mocks.listPlanRequestsWithUsers,
    resolvePlanRequest: mocks.resolvePlanRequest,
    setUserPlan: mocks.setUserPlan,
  }
})

const { Route } = await import('~/routes/api/admin/plan-requests/index')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')
const { LegacyPlanMutationDisabledError } = await import('~/shared/lib/billing')

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/admin/plan-requests', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callPost(body: unknown): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body) })
}

async function callGet(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request('https://app.test/api/admin/plan-requests') })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/admin/plan-requests', () => {
  it('returns historical plan requests regardless of the legacy-mutation gate — reads always remain available', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.listPlanRequestsWithUsers.mockResolvedValue([{ id: 'r1', status: 'approved' }])

    const response = await callGet()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual([{ id: 'r1', status: 'approved' }])
  })
})

describe('POST /api/admin/plan-requests', () => {
  it('resolves a pending request and grants the plan on approval', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.findPlanRequest.mockResolvedValue({ id: 'r1', userId: 'user-1', requestedPlan: 'pro' })

    const response = await callPost({ requestId: 'r1', decision: 'approved' })

    expect(response.status).toBe(200)
    expect(mocks.setUserPlan).toHaveBeenCalledWith('user-1', 'pro', 'admin-1', undefined, expect.any(Date))
  })

  it('returns migration guidance (409) once self-service plan mutations are retired, rather than silently succeeding or 500ing', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.resolvePlanRequest.mockRejectedValue(new LegacyPlanMutationDisabledError())

    const response = await callPost({ requestId: 'r1', decision: 'approved' })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.migrationGuidance).toBe(true)
    expect(mocks.setUserPlan).not.toHaveBeenCalled()
  })

  it('rejects a non-admin caller before resolving anything', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callPost({ requestId: 'r1', decision: 'approved' })

    expect(response.status).toBe(403)
    expect(mocks.resolvePlanRequest).not.toHaveBeenCalled()
  })
})
