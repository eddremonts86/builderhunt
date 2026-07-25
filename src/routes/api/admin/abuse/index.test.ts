import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  listRecentAbuseSignals: vi.fn(),
  getAccountRisk: vi.fn(),
  withPlatformUser: vi.fn(),
  setAccountRiskStageByAdmin: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return {
    ...actual,
    requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal,
    auditPlatformAdminAction: mocks.auditPlatformAdminAction,
  }
})

vi.mock('~/shared/lib/repositories/abuse-signals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/abuse-signals')>()
  return { ...actual, listRecentAbuseSignals: mocks.listRecentAbuseSignals }
})

vi.mock('~/shared/lib/repositories/account-risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/account-risk')>()
  return {
    ...actual,
    getAccountRisk: mocks.getAccountRisk,
    withPlatformUser: mocks.withPlatformUser,
    setAccountRiskStageByAdmin: mocks.setAccountRiskStageByAdmin,
  }
})

const { Route } = await import('./index')

function getRequest(url: string): Request {
  return new Request(url)
}

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/admin/abuse', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callHandler(method: 'GET' | 'POST', request: Request): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: Record<string, (args: { request: Request }) => Promise<Response>> } } }).options.server.handlers[method]
  return handler({ request })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withPlatformUser.mockImplementation((_userId: string, fn: (tx: unknown) => unknown) => fn({}))
})

describe('GET /api/admin/abuse', () => {
  it('requires platform admin authentication', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new Error('unauthorized'))

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/abuse'))

    expect(response.status).toBe(500) // generic Error, not PlatformAdminAuthorizationError, falls through to catch-all
    expect(mocks.listRecentAbuseSignals).not.toHaveBeenCalled()
  })

  it('returns the recent signals with each user\'s current stage', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.listRecentAbuseSignals.mockResolvedValue([
      { id: 'sig-1', type: 'seat_overuse', severity: 'medium', userId: 'user-1', organizationId: null, requestId: 'req-a', details: {}, createdAt: new Date('2026-01-01') },
      { id: 'sig-2', type: 'export_burst', severity: 'high', userId: null, organizationId: 'org-1', requestId: 'req-b', details: {}, createdAt: new Date('2026-01-02') },
    ])
    mocks.getAccountRisk.mockResolvedValue({ userId: 'user-1', riskScore: 40, stage: 'warned', reason: 'concurrent_sessions', updatedAt: new Date('2026-01-01') })

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/abuse'))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.signals).toHaveLength(2)
    expect(data.stageByUserId['user-1']).toMatchObject({ stage: 'warned', riskScore: 40 })
    expect(mocks.getAccountRisk).toHaveBeenCalledTimes(1) // only the one unique, non-null userId
  })

  it('caps the limit query parameter at the maximum', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.listRecentAbuseSignals.mockResolvedValue([])

    await callHandler('GET', getRequest('https://app.test/api/admin/abuse?limit=99999'))

    expect(mocks.listRecentAbuseSignals).toHaveBeenCalledWith(200)
  })
})

describe('POST /api/admin/abuse', () => {
  beforeEach(() => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
  })

  it('rejects an invalid body', async () => {
    const response = await callHandler('POST', postRequest({ userId: 'user-1' }))

    expect(response.status).toBe(400)
    expect(mocks.setAccountRiskStageByAdmin).not.toHaveBeenCalled()
  })

  it('rejects an unknown action', async () => {
    const response = await callHandler('POST', postRequest({ userId: 'user-1', action: 'delete' }))

    expect(response.status).toBe(400)
  })

  it('applies the mapped stage and audits the action', async () => {
    mocks.setAccountRiskStageByAdmin.mockResolvedValue({ userId: 'user-1', riskScore: 0, stage: 'blocked', reason: 'manual block', updatedAt: new Date('2026-01-01') })

    const response = await callHandler('POST', postRequest({ userId: 'user-1', action: 'block', reason: 'manual block' }))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.stage).toBe('blocked')
    expect(mocks.setAccountRiskStageByAdmin).toHaveBeenCalledWith('user-1', 'blocked', 'manual block')
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledTimes(1)
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      { userId: 'admin-1', requestId: 'req-1' },
      expect.objectContaining({ action: 'admin.abuse.account.block', targetType: 'account_risk', targetId: 'user-1', result: 'allowed' }),
    )
  })

  it('maps each action to its enforcement stage', async () => {
    mocks.setAccountRiskStageByAdmin.mockImplementation(async (userId: string, stage: string, reason: string) => ({ userId, riskScore: 0, stage, reason, updatedAt: new Date() }))

    const cases: Array<[string, string]> = [['clear', 'observe'], ['warn', 'warned'], ['stepup', 'stepup'], ['block', 'blocked']]
    for (const [action, expectedStage] of cases) {
      const response = await callHandler('POST', postRequest({ userId: 'user-1', action }))
      const data = await response.json()
      expect(data.stage).toBe(expectedStage)
    }
  })
})
