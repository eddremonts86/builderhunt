import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  createPackCheckout: vi.fn(),
  getBillingProvider: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/billing/packs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/packs')>()
  return { ...actual, createPackCheckout: mocks.createPackCheckout }
})

vi.mock('~/shared/lib/billing/stripe-provider', () => ({
  getBillingProvider: mocks.getBillingProvider,
}))

const { Route } = await import('~/routes/api/billing/checkout/credits')
const { PackCheckoutError } = await import('~/shared/lib/billing/packs')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

const VALID_BODY = {
  catalogKey: 'starter_300',
  country: 'DK',
  disclosures: {
    renewal: true,
    amount: true,
    interval: true,
    cancellationRefundPolicy: true,
    creditExpiryNonTransferability: true,
    tax: true,
    total: true,
  },
  idempotencyKey: 'idem-1',
  successUrl: 'https://app.test/settings/billing/return',
  cancelUrl: 'https://app.test/settings/billing',
}

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/billing/checkout/credits', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callRoute(body: unknown): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, fn: (tx: unknown) => unknown) => fn({}))
  mocks.getBillingProvider.mockReturnValue({})
})

describe('POST /api/billing/checkout/credits — permission matrix', () => {
  it('allows an owner to reach the pack checkout service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.createPackCheckout.mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.test/cs_1', status: 'complete' })

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_1', status: 'complete' })
    expect(mocks.createPackCheckout).toHaveBeenCalledTimes(1)
  })

  it('rejects an admin with 403, never reaching the pack checkout service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(403)
    expect(mocks.createPackCheckout).not.toHaveBeenCalled()
  })

  it('rejects a member with 403, never reaching the pack checkout service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(403)
    expect(mocks.createPackCheckout).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/checkout/credits — spoofed/invalid body fields', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it('rejects a spoofed organizationId in the body (unknown field, strict schema)', async () => {
    const response = await callRoute({ ...VALID_BODY, organizationId: 'attacker-org' })

    expect(response.status).toBe(400)
    expect(mocks.createPackCheckout).not.toHaveBeenCalled()
  })

  it('rejects a spoofed amountCents/priceId/credits in the body (unknown fields, strict schema)', async () => {
    const response = await callRoute({ ...VALID_BODY, amountCents: 1, priceId: 'price_attacker', credits: 999999 })

    expect(response.status).toBe(400)
    expect(mocks.createPackCheckout).not.toHaveBeenCalled()
  })

  it('rejects a body missing a required disclosure acknowledgment', async () => {
    const response = await callRoute({ ...VALID_BODY, disclosures: { ...VALID_BODY.disclosures, tax: false } })

    expect(response.status).toBe(400)
    expect(mocks.createPackCheckout).not.toHaveBeenCalled()
  })

  it('rejects a non-URL successUrl/cancelUrl at the schema layer', async () => {
    const response = await callRoute({ ...VALID_BODY, successUrl: 'not-a-url' })

    expect(response.status).toBe(400)
    expect(mocks.createPackCheckout).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/checkout/credits — service error mapping', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it.each([
    ['billing_disabled', 503],
    ['country_not_allowed', 403],
    ['unknown_catalog_key', 400],
    ['no_active_subscription', 403],
    ['risk_limit_exceeded', 429],
    ['invalid_url', 400],
    ['provider_error', 502],
  ] as const)('maps PackCheckoutError(%s) to HTTP %i', async (code, expectedStatus) => {
    mocks.createPackCheckout.mockRejectedValue(new PackCheckoutError('service error', code))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(expectedStatus)
    expect((await response.json()).code).toBe(code)
  })

  it('maps an unexpected error to a generic 500 without leaking internals', async () => {
    mocks.createPackCheckout.mockRejectedValue(new Error('unexpected db failure with a stack trace'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('Failed to start checkout')
  })
})
