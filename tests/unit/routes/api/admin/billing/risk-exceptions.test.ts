import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  requireRecentPlatformAdminAuthentication: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  issueRiskException: vi.fn(),
  listRiskExceptions: vi.fn(),
  revokeRiskException: vi.fn(),
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

vi.mock('~/shared/lib/billing/risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/risk')>()
  return {
    ...actual,
    issueRiskException: mocks.issueRiskException,
    listRiskExceptions: mocks.listRiskExceptions,
    revokeRiskException: mocks.revokeRiskException,
  }
})

const { Route } = await import('~/routes/api/admin/billing/risk-exceptions')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')
const { RiskExceptionError } = await import('~/shared/lib/billing/risk')

function getRequest(url: string): Request {
  return new Request(url)
}

function jsonRequest(method: 'POST' | 'DELETE', body: unknown): Request {
  return new Request('https://app.test/api/admin/billing/risk-exceptions', {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callHandler(method: 'GET' | 'POST' | 'DELETE', request: Request): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: Record<string, (args: { request: Request }) => Promise<Response>> } } }).options.server.handlers[method]
  return handler({ request })
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('GET /api/admin/billing/risk-exceptions', () => {
  it('requires platform admin authentication', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/risk-exceptions?organizationId=org-1'))

    expect(response.status).toBe(403)
    expect(mocks.listRiskExceptions).not.toHaveBeenCalled()
  })

  it('requires an organizationId query parameter', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/risk-exceptions'))

    expect(response.status).toBe(400)
    expect(mocks.listRiskExceptions).not.toHaveBeenCalled()
  })

  it('returns the exceptions for the given organization', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.listRiskExceptions.mockResolvedValue([{ id: 'exc-1' }])

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/risk-exceptions?organizationId=org-1'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ exceptions: [{ id: 'exc-1' }] })
    expect(mocks.listRiskExceptions).toHaveBeenCalledWith('org-1')
  })
})

describe('POST /api/admin/billing/risk-exceptions', () => {
  beforeEach(() => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
  })

  it('rejects an invalid body', async () => {
    const response = await callHandler('POST', jsonRequest('POST', { organizationId: 'org-1' }))

    expect(response.status).toBe(400)
    expect(mocks.issueRiskException).not.toHaveBeenCalled()
  })

  it('issues an exception and audits the action', async () => {
    mocks.issueRiskException.mockResolvedValue({ id: 'exc-1', organizationId: 'org-1' })

    const response = await callHandler('POST', jsonRequest('POST', { organizationId: 'org-1', reason: 'reviewed', durationMs: 60_000 }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ exception: { id: 'exc-1', organizationId: 'org-1' } })
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledTimes(1)
  })

  it('maps RiskExceptionError to 400', async () => {
    mocks.issueRiskException.mockRejectedValue(new RiskExceptionError('bad duration', 'invalid_duration'))

    const response = await callHandler('POST', jsonRequest('POST', { organizationId: 'org-1', reason: 'reviewed', durationMs: 60_000 }))

    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('invalid_duration')
  })

  it('requires recent authentication before issuing an exception', async () => {
    mocks.requireRecentPlatformAdminAuthentication.mockImplementation(() => {
      throw new PlatformAdminAuthorizationError('Recent re-authentication required', 401)
    })

    const response = await callHandler('POST', jsonRequest('POST', { organizationId: 'org-1', reason: 'reviewed', durationMs: 60_000 }))

    expect(response.status).toBe(401)
    expect(mocks.issueRiskException).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/admin/billing/risk-exceptions', () => {
  beforeEach(() => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
  })

  it('returns 404 when the exception does not exist or is already revoked', async () => {
    mocks.revokeRiskException.mockResolvedValue(null)

    const response = await callHandler('DELETE', jsonRequest('DELETE', { organizationId: 'org-1', exceptionId: 'exc-1' }))

    expect(response.status).toBe(404)
  })

  it('revokes an active exception and audits the action', async () => {
    mocks.revokeRiskException.mockResolvedValue({ id: 'exc-1', organizationId: 'org-1', revokedAt: new Date().toISOString() })

    const response = await callHandler('DELETE', jsonRequest('DELETE', { organizationId: 'org-1', exceptionId: 'exc-1' }))

    expect(response.status).toBe(200)
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledTimes(1)
  })

  it('requires recent authentication before revoking an exception', async () => {
    mocks.requireRecentPlatformAdminAuthentication.mockImplementation(() => {
      throw new PlatformAdminAuthorizationError('Recent re-authentication required', 401)
    })

    const response = await callHandler('DELETE', jsonRequest('DELETE', { organizationId: 'org-1', exceptionId: 'exc-1' }))

    expect(response.status).toBe(401)
    expect(mocks.revokeRiskException).not.toHaveBeenCalled()
  })
})
