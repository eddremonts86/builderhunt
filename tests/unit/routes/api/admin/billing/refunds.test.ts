import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  decideRefund: vi.fn(),
  listBillingRefunds: vi.fn(),
  withPlatformOrganization: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return {
    ...actual,
    requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal,
    auditPlatformAdminAction: mocks.auditPlatformAdminAction,
  }
})

vi.mock('~/shared/lib/billing/refunds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/refunds')>()
  return { ...actual, decideRefund: mocks.decideRefund }
})

vi.mock('~/shared/lib/repositories/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing')>()
  return { ...actual, listBillingRefunds: mocks.listBillingRefunds }
})

vi.mock('~/shared/lib/repositories/billing-risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing-risk')>()
  return { ...actual, withPlatformOrganization: mocks.withPlatformOrganization }
})

const { Route } = await import('~/routes/api/admin/billing/refunds')
const { RefundError } = await import('~/shared/lib/billing/refunds')

function getRequest(url: string): Request {
  return new Request(url)
}

function putRequest(body: unknown): Request {
  return new Request('https://app.test/api/admin/billing/refunds', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callHandler(method: 'GET' | 'PUT', request: Request): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: Record<string, (args: { request: Request }) => Promise<Response>> } } }).options.server.handlers[method]
  return handler({ request })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withPlatformOrganization.mockImplementation((_organizationId: string, fn: (tx: unknown) => unknown) => fn({}))
})

describe('GET /api/admin/billing/refunds', () => {
  it('requires platform admin authentication', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new Error('unauthorized'))

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/refunds?organizationId=org-1'))

    expect(response.status).toBe(500) // generic Error, not PlatformAdminAuthorizationError, falls through to catch-all
  })

  it('requires an organizationId query parameter', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/refunds'))

    expect(response.status).toBe(400)
    expect(mocks.listBillingRefunds).not.toHaveBeenCalled()
  })

  it('returns the refunds for the given organization', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.listBillingRefunds.mockResolvedValue([{ id: 'refund-1' }])

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/refunds?organizationId=org-1'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ refunds: [{ id: 'refund-1' }] })
  })
})

describe('PUT /api/admin/billing/refunds', () => {
  beforeEach(() => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
  })

  it('rejects an invalid body', async () => {
    const response = await callHandler('PUT', putRequest({ organizationId: 'org-1' }))

    expect(response.status).toBe(400)
    expect(mocks.decideRefund).not.toHaveBeenCalled()
  })

  it('records the decision and audits the action', async () => {
    mocks.decideRefund.mockResolvedValue({ id: 'refund-1', organizationId: 'org-1', policyDecision: 'partial_pack_operator', amountCents: 500 })

    const response = await callHandler('PUT', putRequest({
      organizationId: 'org-1', refundId: 'refund-1', policyDecision: 'partial_pack_operator', amountCents: 500, creditRevocationUnits: 10,
    }))

    expect(response.status).toBe(200)
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledTimes(1)
  })

  it('maps RefundError to its status code', async () => {
    mocks.decideRefund.mockRejectedValue(new RefundError('conflict', 'decision_conflict'))

    const response = await callHandler('PUT', putRequest({
      organizationId: 'org-1', refundId: 'refund-1', policyDecision: 'partial_pack_operator', amountCents: 500,
    }))

    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('decision_conflict')
  })
})
