import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  getOrganizationBillingSummary: vi.fn(),
  getBillingAvailability: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/billing/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/contracts')>()
  return {
    ...actual,
    getOrganizationBillingSummary: mocks.getOrganizationBillingSummary,
    getBillingAvailability: mocks.getBillingAvailability,
  }
})

const { Route } = await import('./summary')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

function getRequest(): Request {
  return new Request('https://app.test/api/billing/summary')
}

async function callRoute(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: getRequest() })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/billing/summary — role-minimized routing', () => {
  it('returns the full canonical summary for an owner', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    const summary = { tier: 'pro', status: 'active', capabilities: { paidActionsAllowed: true, canOpenPortal: true, canRequestRefund: true, canConfigureAutoRecharge: true } }
    mocks.getOrganizationBillingSummary.mockResolvedValue(summary)

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(summary)
    expect(mocks.getBillingAvailability).not.toHaveBeenCalled()
  })

  it('returns the full canonical summary for an admin (read-only, per spec.md)', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))
    const summary = { tier: 'team', status: 'active', capabilities: { paidActionsAllowed: true, canOpenPortal: false, canRequestRefund: false, canConfigureAutoRecharge: false } }
    mocks.getOrganizationBillingSummary.mockResolvedValue(summary)

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(summary)
    expect(body.capabilities.canOpenPortal).toBe(false)
  })

  it('returns only the availability DTO for a plain member — never the elevated summary', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))
    mocks.getBillingAvailability.mockResolvedValue({ capabilities: { paidActionsAllowed: true } })

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ capabilities: { paidActionsAllowed: true } })
    expect(mocks.getOrganizationBillingSummary).not.toHaveBeenCalled()
    expect(body).not.toHaveProperty('activeCreditGrants')
    expect(body).not.toHaveProperty('recentRefunds')
    expect(body).not.toHaveProperty('seats')
  })

  it('propagates a 401 for a signed-out caller', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Unauthorized', 401))

    const response = await callRoute()

    expect(response.status).toBe(401)
    expect(mocks.getOrganizationBillingSummary).not.toHaveBeenCalled()
    expect(mocks.getBillingAvailability).not.toHaveBeenCalled()
  })

  it('returns a 500 without leaking internals on an unexpected error', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getOrganizationBillingSummary.mockRejectedValue(new Error('db exploded'))

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).not.toMatch(/db exploded/)
  })
})
