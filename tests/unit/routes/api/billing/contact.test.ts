import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  getSession: vi.fn(),
  withTenantContext: vi.fn(),
  getVerifiedBillingContact: vi.fn(),
  setBillingContact: vi.fn(),
  sendBillingContactVerificationEmail: vi.fn(),
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

vi.mock('~/shared/lib/billing/billing-contact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/billing-contact')>()
  return { ...actual, getVerifiedBillingContact: mocks.getVerifiedBillingContact, setBillingContact: mocks.setBillingContact }
})

vi.mock('~/shared/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/email')>()
  return { ...actual, sendBillingContactVerificationEmail: mocks.sendBillingContactVerificationEmail }
})

const { Route } = await import('~/routes/api/billing/contact')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')
const { BillingAuthorizationError } = await import('~/shared/lib/billing/permissions')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

const RECENT_SESSION = { session: { createdAt: new Date().toISOString() } }

function getRequest(): Request {
  return new Request('https://app.test/api/billing/contact')
}

function putRequest(body: unknown): Request {
  return new Request('https://app.test/api/billing/contact', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callGet(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: getRequest() })
}

async function callPut(body: unknown): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { PUT: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.PUT
  return handler({ request: putRequest(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, fn: (tx: unknown) => unknown) => fn({}))
  mocks.getSession.mockResolvedValue(RECENT_SESSION)
  mocks.sendBillingContactVerificationEmail.mockResolvedValue({ ok: true, devLink: 'https://app.test/verify?token=abc' })
})

describe('GET /api/billing/contact', () => {
  it('allows an owner to read the current contact', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getVerifiedBillingContact.mockResolvedValue({ email: 'billing@example.com', verifiedAt: '2026-01-01T00:00:00.000Z' })

    const response = await callGet()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.contact.email).toBe('billing@example.com')
  })

  it('allows an admin to read (billing:read)', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))
    mocks.getVerifiedBillingContact.mockResolvedValue(null)

    const response = await callGet()
    expect(response.status).toBe(200)
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
})

describe('PUT /api/billing/contact', () => {
  it('allows an owner with a recent session to set a new contact and sends the verification email', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.setBillingContact.mockResolvedValue(undefined)

    const response = await callPut({ email: 'billing@example.com' })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.devLink).toBe('https://app.test/verify?token=abc')
    expect(mocks.sendBillingContactVerificationEmail).toHaveBeenCalledWith('billing@example.com', expect.stringContaining('/api/billing/contact/verify?token='))
  })

  it('rejects an invalid email with 400 before touching the service layer', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))

    const response = await callPut({ email: 'not-an-email' })

    expect(response.status).toBe(400)
    expect(mocks.setBillingContact).not.toHaveBeenCalled()
  })

  it('rejects an admin via the underlying permission check', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))
    mocks.setBillingContact.mockRejectedValue(new BillingAuthorizationError('Forbidden', 403))

    const response = await callPut({ email: 'billing@example.com' })

    expect(response.status).toBe(403)
    expect(mocks.sendBillingContactVerificationEmail).not.toHaveBeenCalled()
  })

  it('rejects an owner with a stale session', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getSession.mockResolvedValue({ session: { createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() } })
    mocks.setBillingContact.mockRejectedValue(new BillingAuthorizationError('Please sign in again to continue', 401))

    const response = await callPut({ email: 'billing@example.com' })

    expect(response.status).toBe(401)
  })

  it('returns 500 without sending a verification email when the send itself fails', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.setBillingContact.mockResolvedValue(undefined)
    mocks.sendBillingContactVerificationEmail.mockResolvedValue({ ok: false, error: 'boom' })

    const response = await callPut({ email: 'billing@example.com' })

    expect(response.status).toBe(500)
  })
})
