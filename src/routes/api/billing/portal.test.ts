import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  getSession: vi.fn(),
  withTenantContext: vi.fn(),
  createBillingPortalSession: vi.fn(),
  getBillingProvider: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/auth/better-auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/billing/portal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/portal')>()
  return { ...actual, createBillingPortalSession: mocks.createBillingPortalSession }
})

vi.mock('~/shared/lib/billing/stripe-provider', () => ({
  getBillingProvider: mocks.getBillingProvider,
}))

const { Route } = await import('./portal')
const { PortalError } = await import('~/shared/lib/billing/portal')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

const VALID_BODY = { returnUrl: 'https://app.test/settings/billing' }

function recentSession(secondsAgo = 10) {
  return { session: { createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString() } }
}

function staleSession() {
  return { session: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() } }
}

async function callRoute(body: unknown = VALID_BODY): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: new Request('https://app.test/api/billing/portal', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, fn: (tx: unknown) => unknown) => fn({}))
  mocks.getBillingProvider.mockReturnValue({})
  mocks.getSession.mockResolvedValue(recentSession())
})

describe('POST /api/billing/portal — permission matrix', () => {
  it('allows an owner with a recent sign-in to open the Portal', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.createBillingPortalSession.mockResolvedValue({ url: 'https://billing.stripe.test/portal/cus_1' })

    const response = await callRoute()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ url: 'https://billing.stripe.test/portal/cus_1' })
  })

  it('rejects an admin with 403, never reaching the Portal service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled()
  })

  it('rejects a member with 403, never reaching the Portal service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled()
  })

  it('rejects an owner whose session is stale (recent-auth required) with 401', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getSession.mockResolvedValue(staleSession())

    const response = await callRoute()

    expect(response.status).toBe(401)
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled()
  })

  it('rejects an owner with no session at all (401)', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getSession.mockResolvedValue(null)

    const response = await callRoute()

    expect(response.status).toBe(401)
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/portal — body validation and error mapping', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it('rejects a spoofed organizationId in the body (unknown field, strict schema)', async () => {
    const response = await callRoute({ ...VALID_BODY, organizationId: 'attacker-org' })

    expect(response.status).toBe(400)
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled()
  })

  it('rejects a non-URL returnUrl at the schema layer', async () => {
    const response = await callRoute({ returnUrl: 'not-a-url' })

    expect(response.status).toBe(400)
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled()
  })

  it('maps a no_customer PortalError to 404', async () => {
    mocks.createBillingPortalSession.mockRejectedValue(new PortalError('no customer', 'no_customer'))

    const response = await callRoute()

    expect(response.status).toBe(404)
  })

  it('maps an invalid_url PortalError to 400', async () => {
    mocks.createBillingPortalSession.mockRejectedValue(new PortalError('bad url', 'invalid_url'))

    const response = await callRoute()

    expect(response.status).toBe(400)
  })

  it('maps an unexpected error to a generic 500', async () => {
    mocks.createBillingPortalSession.mockRejectedValue(new Error('unexpected'))

    const response = await callRoute()

    expect(response.status).toBe(500)
  })
})
