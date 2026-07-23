import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  getOwnershipTransferBillingPreview: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/billing/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/contracts')>()
  return { ...actual, getOwnershipTransferBillingPreview: mocks.getOwnershipTransferBillingPreview }
})

const { Route } = await import('./transfer-ownership-preview')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

async function callGet(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request('https://app.test/api/organizations/transfer-ownership-preview') })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/organizations/transfer-ownership-preview', () => {
  it('allows an owner (organization:transfer) and returns the billing preview', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getOwnershipTransferBillingPreview.mockResolvedValue({
      hasBillingCustomer: true,
      paymentMethod: { brand: 'visa', last4: '4242' },
      tier: 'team',
      billingPeriod: 'monthly',
      currentPeriodEnd: '2026-02-01T00:00:00.000Z',
      nextChargeAmountCents: 4900,
      cancelAtPeriodEnd: false,
    })

    const response = await callGet()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.paymentMethod).toEqual({ brand: 'visa', last4: '4242' })
    expect(body.nextChargeAmountCents).toBe(4900)
  })

  it('rejects an admin — this is owner-only, same authority as the transfer action itself', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))

    const response = await callGet()

    expect(response.status).toBe(403)
    expect(mocks.getOwnershipTransferBillingPreview).not.toHaveBeenCalled()
  })

  it('rejects a member', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callGet()

    expect(response.status).toBe(403)
  })

  it('propagates a 401 for a signed-out caller', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Unauthorized', 401))

    const response = await callGet()

    expect(response.status).toBe(401)
  })

  it('is NOT recent-auth-gated — a merely-authenticated owner can load the preview', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getOwnershipTransferBillingPreview.mockResolvedValue({
      hasBillingCustomer: false,
      paymentMethod: null,
      tier: 'free',
      billingPeriod: 'monthly',
      currentPeriodEnd: null,
      nextChargeAmountCents: null,
      cancelAtPeriodEnd: false,
    })

    const response = await callGet()

    expect(response.status).toBe(200)
  })

  it('returns 500 when the preview composer throws unexpectedly', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getOwnershipTransferBillingPreview.mockRejectedValue(new Error('boom'))

    const response = await callGet()

    expect(response.status).toBe(500)
  })
})
