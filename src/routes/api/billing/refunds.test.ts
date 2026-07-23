import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  getSession: vi.fn(),
  withTenantContext: vi.fn(),
  requestPackRefund: vi.fn(),
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

vi.mock('~/shared/lib/billing/refunds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/refunds')>()
  return { ...actual, requestPackRefund: mocks.requestPackRefund }
})

const { Route } = await import('./refunds')
const { RefundError } = await import('~/shared/lib/billing/refunds')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

const RECENT_SESSION = { session: { createdAt: new Date().toISOString() } }
const VALID_BODY = { grantId: 'grant-1', idempotencyKey: 'idem-1' }

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/billing/refunds', {
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
  mocks.getSession.mockResolvedValue(RECENT_SESSION)
})

describe('POST /api/billing/refunds — permission matrix', () => {
  it('allows an owner to submit a refund request', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.requestPackRefund.mockResolvedValue({ id: 'refund-1', state: 'pending' })

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ refund: { id: 'refund-1', state: 'pending' } })
  })

  it('rejects an admin with 403', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(403)
    expect(mocks.requestPackRefund).not.toHaveBeenCalled()
  })

  it('rejects a member with 403', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('member'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(403)
  })

  it('rejects an owner with a stale session (401) — recent-auth required', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.getSession.mockResolvedValue({ session: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() } })

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(401)
    expect(mocks.requestPackRefund).not.toHaveBeenCalled()
  })
})

describe('POST /api/billing/refunds — body validation and error mapping', () => {
  beforeEach(() => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
  })

  it('rejects a spoofed field (unknown key, strict schema)', async () => {
    const response = await callRoute({ ...VALID_BODY, organizationId: 'attacker-org' })

    expect(response.status).toBe(400)
    expect(mocks.requestPackRefund).not.toHaveBeenCalled()
  })

  it.each([
    ['grant_not_found', 404],
    ['not_a_pack_grant', 400],
    ['partially_used', 409],
    ['not_active', 409],
    ['unknown_pack_catalog_key', 400],
    ['decision_conflict', 409],
  ] as const)('maps RefundError(%s) to HTTP %i', async (code, expectedStatus) => {
    mocks.requestPackRefund.mockRejectedValue(new RefundError('service error', code))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(expectedStatus)
    expect((await response.json()).code).toBe(code)
  })

  it('maps an unexpected error to a generic 500', async () => {
    mocks.requestPackRefund.mockRejectedValue(new Error('unexpected db failure'))

    const response = await callRoute(VALID_BODY)

    expect(response.status).toBe(500)
  })
})
