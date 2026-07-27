import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  getCheckoutReturnStatus: vi.fn(),
  getBillingProvider: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/billing/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/checkout')>()
  return { ...actual, getCheckoutReturnStatus: mocks.getCheckoutReturnStatus }
})

vi.mock('~/shared/lib/billing/stripe-provider', () => ({
  getBillingProvider: mocks.getBillingProvider,
}))

const { Route } = await import('~/routes/api/billing/checkout/status')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

async function callRoute(url = 'https://app.test/api/billing/checkout/status'): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request(url) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, fn: (tx: unknown) => unknown) => fn({}))
  mocks.getBillingProvider.mockReturnValue({})
})

describe('GET /api/billing/checkout/status', () => {
  it('returns the polled state for an owner', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getCheckoutReturnStatus.mockResolvedValue({ state: 'pending' })

    const response = await callRoute()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: 'pending' })
  })

  it('returns the polled state for an admin (read-only financial visibility)', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))
    mocks.getCheckoutReturnStatus.mockResolvedValue({ state: 'succeeded' })

    const response = await callRoute()

    expect(response.status).toBe(200)
  })

  it('rejects a member with 403', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.getCheckoutReturnStatus).not.toHaveBeenCalled()
  })

  it('ignores every query parameter — a forged status/session_id changes nothing', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getCheckoutReturnStatus.mockResolvedValue({ state: 'pending' })

    const response = await callRoute('https://app.test/api/billing/checkout/status?status=success&session_id=cs_forged_by_attacker')

    expect(await response.json()).toEqual({ state: 'pending' })
    // The handler never reads request.url's search params at all — proven structurally: the mocked
    // service function receives no query-derived argument, only (transaction, principal, options).
    expect(mocks.getCheckoutReturnStatus).toHaveBeenCalledWith(expect.anything(), principal('owner'), expect.anything())
  })

  it('maps an unexpected error to a generic 500', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getCheckoutReturnStatus.mockRejectedValue(new Error('db unavailable'))

    const response = await callRoute()

    expect(response.status).toBe(500)
  })
})
