import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  cancelSubscriptionAtPeriodEnd: vi.fn(),
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
  return { ...actual, cancelSubscriptionAtPeriodEnd: mocks.cancelSubscriptionAtPeriodEnd }
})

vi.mock('~/shared/lib/billing/stripe-provider', () => ({
  getBillingProvider: mocks.getBillingProvider,
}))

const { Route } = await import('~/routes/api/billing/subscription/cancel')
const { SubscriptionChangeError } = await import('~/shared/lib/billing/subscription-changes')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

async function callRoute(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: new Request('https://app.test/api/billing/subscription/cancel', { method: 'POST' }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, fn: (tx: unknown) => unknown) => fn({}))
  mocks.getBillingProvider.mockReturnValue({})
})

describe('POST /api/billing/subscription/cancel — permission matrix', () => {
  it('allows an owner to reach the cancellation service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.cancelSubscriptionAtPeriodEnd.mockResolvedValue({ cancelAtPeriodEnd: true, effectiveAt: '2026-04-01T00:00:00.000Z' })

    const response = await callRoute()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ cancelAtPeriodEnd: true, effectiveAt: '2026-04-01T00:00:00.000Z' })
    expect(mocks.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(1)
  })

  it('rejects an admin with 403, never reaching the cancellation service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled()
  })

  it('rejects a member with 403, never reaching the cancellation service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/subscription/cancel — service error mapping', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it('maps no_active_subscription to 409', async () => {
    mocks.cancelSubscriptionAtPeriodEnd.mockRejectedValue(new SubscriptionChangeError('No active subscription', 'no_active_subscription'))

    const response = await callRoute()

    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('no_active_subscription')
  })

  it('maps an unexpected error to a generic 500 without leaking internals', async () => {
    mocks.cancelSubscriptionAtPeriodEnd.mockRejectedValue(new Error('unexpected db failure with a stack trace'))

    const response = await callRoute()

    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('Failed to cancel subscription')
  })
})
