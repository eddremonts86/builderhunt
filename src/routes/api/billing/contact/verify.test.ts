import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  verifyBillingContact: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/billing/billing-contact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/billing-contact')>()
  return { ...actual, verifyBillingContact: mocks.verifyBillingContact }
})

const { Route } = await import('./verify')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')

function principal(): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role: 'owner', requestId: 'request-1' }
}

function getRequest(token: string | null): Request {
  const url = token ? `https://app.test/api/billing/contact/verify?token=${encodeURIComponent(token)}` : 'https://app.test/api/billing/contact/verify'
  return new Request(url)
}

async function callRoute(token: string | null): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: getRequest(token) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, fn: (tx: unknown) => unknown) => fn({}))
})

describe('GET /api/billing/contact/verify', () => {
  it('redirects to billing settings on a successful verification', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    mocks.verifyBillingContact.mockResolvedValue({ email: 'billing@example.com', verifiedAt: '2026-01-01T00:00:00.000Z' })

    const response = await callRoute('good-token')

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/settings/billing?billingContactVerified=1')
  })

  it('redirects to an error state on an invalid or expired token', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    mocks.verifyBillingContact.mockResolvedValue(null)

    const response = await callRoute('bad-token')

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('billingContactError=')
  })

  it('redirects to an error state when no token is present at all', async () => {
    const response = await callRoute(null)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('billingContactError=')
    expect(mocks.requireTenantPrincipal).not.toHaveBeenCalled()
  })

  it('redirects to sign-in with a callback URL when signed out', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Unauthorized', 401))

    const response = await callRoute('good-token')

    expect(response.status).toBe(302)
    const location = response.headers.get('Location') ?? ''
    expect(location).toContain('/auth/sign-in?callbackURL=')
    expect(location).toContain(encodeURIComponent('/api/billing/contact/verify?token=good-token'))
  })
})
