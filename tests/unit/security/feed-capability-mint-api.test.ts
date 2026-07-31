// /api/queries/$id/feed-capability — security suite.
//
// Regression coverage for the RSS token mismatch found during the 2026-07-31 phase-1 audit:
// the dashboard's "Copy RSS feed URL" built a link from a legacy HMAC-over-saved-query-id scheme
// that the real /api/feeds/$capabilityId route never accepted (every copied link 404'd). This
// route mints a real feed_capabilities row via the repository that route actually reads from.
//
// Verifies:
// - 404 when the saved query isn't owned by the principal's organization (no id-guessing mint).
// - 201 with the minted id/token/url when it is owned.
// - 401 for unauthenticated.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  findSavedQueryById: vi.fn(),
  createFeedCapability: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', () => ({
  requireTenantPrincipal: mocks.requireTenantPrincipal,
  TenantAuthorizationError: class extends Error {
    constructor(message: string, readonly status: 401 | 403) {
      super(message)
      this.name = 'TenantAuthorizationError'
    }
  },
}))

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/repositories/saved-queries', () => ({
  findSavedQueryById: mocks.findSavedQueryById,
}))

vi.mock('~/shared/lib/repositories/public-feeds', () => ({
  createFeedCapability: mocks.createFeedCapability,
}))

vi.mock('~/shared/lib/rate-limit', () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 20, resetMs: 0 }),
}))

const { Route } = await import('~/routes/api/queries/$id/feed-capability')

const principal = { userId: 'u-1', organizationId: 'org-1', role: 'owner' as const, requestId: 'r-1' }

function call(id: string): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { POST: (a: { request: Request; params: { id: string } }) => Promise<Response> } } }
  }).options.server.handlers.POST
  return handler({ request: new Request(`https://app.test/api/queries/${id}/feed-capability`, { method: 'POST' }), params: { id } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireTenantPrincipal.mockResolvedValue(principal)
  mocks.withTenantContext.mockImplementation(async (_p, cb) => cb({} as never))
})

describe('POST /api/queries/$id/feed-capability', () => {
  it('mints a real capability for a query the org owns', async () => {
    mocks.findSavedQueryById.mockResolvedValue({ id: 'q-1', organizationId: 'org-1', name: 'Rust engineers' })
    mocks.createFeedCapability.mockResolvedValue({ id: 'fc_abc', capability: 'raw-token-xyz' })

    const response = await call('q-1')
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body).toEqual({
      id: 'fc_abc',
      token: 'raw-token-xyz',
      url: '/api/feeds/fc_abc?format=rss&token=raw-token-xyz',
    })
    expect(mocks.findSavedQueryById).toHaveBeenCalledWith({}, 'org-1', 'q-1')
    expect(mocks.createFeedCapability).toHaveBeenCalledWith('org-1', 'q-1', { mintedByUserId: 'u-1' })
  })

  it('returns 404 without minting when the query is not owned by this organization', async () => {
    mocks.findSavedQueryById.mockResolvedValue(null)

    const response = await call('q-someone-elses')
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toBe('Saved search not found')
    expect(mocks.createFeedCapability).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated', async () => {
    const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Not authenticated', 401))

    const response = await call('q-1')
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.error).toBe('Not authenticated')
    expect(mocks.createFeedCapability).not.toHaveBeenCalled()
  })
})
