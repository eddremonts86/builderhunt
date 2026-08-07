import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  pageAbuseSignals: vi.fn(),
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
  return { ...actual, pageAbuseSignals: mocks.pageAbuseSignals }
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

const { Route } = await import('~/routes/api/admin/abuse/index')

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
    // The point of the assertion: authorization runs before anything reads. `platformTablePageHandler`
    // authenticates before it even parses the search params, per `security:auth-before-validate`.
    expect(mocks.pageAbuseSignals).not.toHaveBeenCalled()
  })

  /**
   * The feed is a `PageResult` now, and the stage rides on the row it belongs to rather than in a
   * side map the client has to join. Phase 3 plan 08 moved this route onto the shared table shell.
   */
  it('returns a page of signals with each user\'s current stage on the row', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.pageAbuseSignals.mockResolvedValue({
      rows: [
        { id: 'sig-1', type: 'seat_overuse', severity: 'medium', userId: 'user-1', organizationId: null, requestId: 'req-a', details: {}, createdAt: new Date('2026-01-01') },
        { id: 'sig-2', type: 'export_burst', severity: 'high', userId: null, organizationId: 'org-1', requestId: 'req-b', details: {}, createdAt: new Date('2026-01-02') },
      ],
      nextCursor: null,
      total: 2,
      facets: {},
    })
    mocks.getAccountRisk.mockResolvedValue({ userId: 'user-1', riskScore: 40, stage: 'warned', reason: 'concurrent_sessions', updatedAt: new Date('2026-01-01') })

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/abuse'))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.rows).toHaveLength(2)
    expect(data.total).toBe(2)
    expect(data.rows[0].stage).toMatchObject({ stage: 'warned', riskScore: 40 })
    // The signal with no user gets a null stage rather than a lookup.
    expect(data.rows[1].stage).toBeNull()
    expect(mocks.getAccountRisk).toHaveBeenCalledTimes(1) // only the one unique, non-null userId
  })

  /**
   * `?limit=` is gone. Page size is `TABLE_PAGE_SIZE`, clamped by the keyset builder — a client
   * cannot widen its own page, which is why there is nothing left here to cap.
   */
  it('refuses an unknown sort id rather than absorbing it', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.pageAbuseSignals.mockRejectedValue(
      new (await import('~/shared/lib/table/keyset')).TableQueryError('Unknown sort column: nope'),
    )

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/abuse?sort=nope:desc'))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('Unknown sort column')
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
