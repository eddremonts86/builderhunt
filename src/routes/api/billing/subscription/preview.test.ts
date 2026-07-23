import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  previewSubscriptionChange: vi.fn(),
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
  return { ...actual, previewSubscriptionChange: mocks.previewSubscriptionChange }
})

vi.mock('~/shared/lib/billing/stripe-provider', () => ({
  getBillingProvider: mocks.getBillingProvider,
}))

const { Route } = await import('./preview')
const { SubscriptionChangeError } = await import('~/shared/lib/billing/subscription-changes')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/billing/subscription/preview', {
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

describe('POST /api/billing/subscription/preview — permission matrix', () => {
  it('allows an owner to reach the preview service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.previewSubscriptionChange.mockResolvedValue({ direction: 'upgrade', timing: 'immediate', creditDelta: 100 })

    const response = await callRoute({ newCatalogKey: 'pro_max_monthly' })

    expect(response.status).toBe(200)
    expect(mocks.previewSubscriptionChange).toHaveBeenCalledTimes(1)
  })

  it('rejects an admin with 403, never reaching the preview service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))

    const response = await callRoute({ newCatalogKey: 'pro_max_monthly' })

    expect(response.status).toBe(403)
    expect(mocks.previewSubscriptionChange).not.toHaveBeenCalled()
  })

  it('rejects a member with 403, never reaching the preview service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute({ newCatalogKey: 'pro_max_monthly' })

    expect(response.status).toBe(403)
    expect(mocks.previewSubscriptionChange).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/subscription/preview — spoofed/invalid body', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it('rejects a spoofed amount field (unknown field, strict schema)', async () => {
    const response = await callRoute({ newCatalogKey: 'pro_max_monthly', amountCents: 1 })

    expect(response.status).toBe(400)
    expect(mocks.previewSubscriptionChange).not.toHaveBeenCalled()
  })

  it('rejects an empty newCatalogKey', async () => {
    const response = await callRoute({ newCatalogKey: '' })

    expect(response.status).toBe(400)
    expect(mocks.previewSubscriptionChange).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/subscription/preview — service error mapping', () => {
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
    mocks.previewSubscriptionChange.mockRejectedValue(new SubscriptionChangeError('service error', code))

    const response = await callRoute({ newCatalogKey: 'pro_max_monthly' })

    expect(response.status).toBe(expectedStatus)
    expect((await response.json()).code).toBe(code)
  })

  it('maps an unexpected error to a generic 500 without leaking internals', async () => {
    mocks.previewSubscriptionChange.mockRejectedValue(new Error('unexpected db failure with a stack trace'))

    const response = await callRoute({ newCatalogKey: 'pro_max_monthly' })

    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('Failed to preview subscription change')
  })
})
