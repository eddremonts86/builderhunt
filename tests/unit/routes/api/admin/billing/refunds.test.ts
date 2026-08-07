import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  decideRefund: vi.fn(),
  pageBillingRefunds: vi.fn(),
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
  return { ...actual, pageBillingRefunds: mocks.pageBillingRefunds }
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

const PAGE = { rows: [{ id: 'refund-1' }], nextCursor: null, total: 1, facets: {} }

describe('GET /api/admin/billing/refunds', () => {
  it('requires platform admin authentication', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new Error('unauthorized'))

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/refunds?filter.organizationId=org-1'))

    expect(response.status).toBe(500) // generic Error, not PlatformAdminAuthorizationError, falls through to catch-all
  })

  it('requires the organization filter', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/refunds'))

    expect(response.status).toBe(400)
    expect(mocks.pageBillingRefunds).not.toHaveBeenCalled()
  })

  /**
   * The platform role's SELECT policy on `billing_refunds` is org-scoped, so exactly one value can
   * be `set_config`'d. Answering with whichever arrived first would show one workspace's refunds
   * under a filter chip naming two — a wrong list that looks like a working one.
   */
  it('refuses two organizations rather than picking one', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const response = await callHandler('GET', getRequest(
      'https://app.test/api/admin/billing/refunds?filter.organizationId=org-1&filter.organizationId=org-2',
    ))

    expect(response.status).toBe(400)
    expect(mocks.pageBillingRefunds).not.toHaveBeenCalled()
  })

  it('scopes the read to the filtered organization and returns a page', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.pageBillingRefunds.mockResolvedValue(PAGE)

    const response = await callHandler('GET', getRequest('https://app.test/api/admin/billing/refunds?filter.organizationId=org-1'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(PAGE)
    expect(mocks.withPlatformOrganization).toHaveBeenCalledWith('org-1', expect.any(Function))
  })

  /** The cursor and the sort id are the client's only structural inputs, and neither is absorbed. */
  it('refuses an unknown sort id', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.pageBillingRefunds.mockResolvedValue(PAGE)

    const response = await callHandler('GET', getRequest(
      'https://app.test/api/admin/billing/refunds?filter.organizationId=org-1&sort=nope:desc',
    ))

    // The capability rejects it inside `pageBillingRefunds`, which the mock stands in for here —
    // so this asserts the parameter reaches the page builder rather than being silently dropped.
    expect(mocks.pageBillingRefunds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sort: [{ id: 'nope', dir: 'desc' }] }),
      expect.anything(),
    )
    expect(response.status).toBe(200)
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
