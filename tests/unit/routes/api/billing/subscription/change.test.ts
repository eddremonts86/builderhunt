import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  changeSubscription: vi.fn(),
  getBillingProvider: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/billing/subscription-changes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/subscription-changes')>()
  return { ...actual, changeSubscription: mocks.changeSubscription }
})

vi.mock('~/shared/lib/billing/stripe-provider', () => ({
  getBillingProvider: mocks.getBillingProvider,
}))

const { Route } = await import('~/routes/api/billing/subscription/change')
const { SubscriptionChangeError } = await import('~/shared/lib/billing/subscription-changes')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

const VALID_BODY = {
  newCatalogKey: 'pro_max_monthly',
  fingerprint: 'sub_1:2026-03-01T00:00:00.000Z',
  idempotencyKey: 'idem-1',
}

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/billing/subscription/change', {
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

describe('POST /api/billing/subscription/change — permission matrix', () => {
  it('allows an owner to reach the change service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.changeSubscription.mockResolvedValue({ applied: 'immediate', newCatalogKey: 'pro_max_monthly', effectiveAt: '2026-03-16T00:00:00.000Z', creditDelta: 290 })

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(200)
    expect(mocks.changeSubscription).toHaveBeenCalledTimes(1)
  })

  it('rejects an admin with 403, never reaching the change service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(403)
    expect(mocks.changeSubscription).not.toHaveBeenCalled()
  })

  it('rejects a member with 403, never reaching the change service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(403)
    expect(mocks.changeSubscription).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/subscription/change — spoofed/invalid body', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it('rejects a spoofed amount/price field (unknown field, strict schema) — never trust a client-supplied charge', async () => {
    const response = await callRoute({ ...VALID_BODY, amountCents: 1, priceId: 'price_attacker' })

    expect(response.status).toBe(400)
    expect(mocks.changeSubscription).not.toHaveBeenCalled()
  })

  it('rejects a missing fingerprint', async () => {
    const { fingerprint: _fingerprint, ...withoutFingerprint } = VALID_BODY
    const response = await callRoute(withoutFingerprint)

    expect(response.status).toBe(400)
    expect(mocks.changeSubscription).not.toHaveBeenCalled()
  })

  it('rejects a missing idempotencyKey', async () => {
    const { idempotencyKey: _idempotencyKey, ...withoutKey } = VALID_BODY
    const response = await callRoute(withoutKey)

    expect(response.status).toBe(400)
    expect(mocks.changeSubscription).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/subscription/change — service error mapping', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it.each([
    ['no_active_subscription', 409],
    ['unknown_catalog_key', 400],
    ['unresolvable_current_plan', 409],
    ['no_price_configured', 400],
    ['stale_preview', 409],
    ['payment_failed', 402],
    ['requires_action', 402],
  ] as const)('maps SubscriptionChangeError(%s) to HTTP %i', async (code, expectedStatus) => {
    mocks.changeSubscription.mockRejectedValue(new SubscriptionChangeError('service error', code))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(expectedStatus)
    expect((await response.json()).code).toBe(code)
  })

  it('maps a stale preview rejection to 409 (must re-preview)', async () => {
    mocks.changeSubscription.mockRejectedValue(new SubscriptionChangeError('Subscription changed since the preview was generated', 'stale_preview'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(409)
  })

  it('maps an unexpected error to a generic 500 without leaking internals', async () => {
    mocks.changeSubscription.mockRejectedValue(new Error('unexpected db failure with a stack trace'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('Failed to change subscription')
  })
})
