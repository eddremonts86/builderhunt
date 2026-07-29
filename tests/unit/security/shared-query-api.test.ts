// /api/queries/$id/visibility — security suite.
//
// Verifies:
// - 401 for unauthenticated.
// - 404 (not 403) for a query the caller cannot read, so a probe by
//   id cannot enumerate which ids exist.
// - 422 for an unknown visibility value.
// - 200 for the owner flipping private→organization.
// - 403 for a peer in the same org flipping on someone else's private
//   query (the visibility action is read-then-share; a peer cannot
//   read the row, so the action is gated on resource:share which
//   requires ownership).

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  changeSavedQueryVisibilityForPrincipal: vi.fn(),
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

const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/repositories/saved-queries', () => ({
  changeSavedQueryVisibilityForPrincipal: mocks.changeSavedQueryVisibilityForPrincipal,
}))

const { Route } = await import('~/routes/api/queries/$id/visibility')
const { SharedResourceError } = await import('~/shared/lib/shared-resources/contracts')

const principal = { userId: 'u-1', organizationId: 'org-1', role: 'owner' as const, requestId: 'r-1' }

function call(body: unknown): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { POST: (a: { request: Request; params: { id: string } }) => Promise<Response> } } }
  }).options.server.handlers.POST
  return handler({
    request: new Request('https://app.test/api/queries/q-1/visibility', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    params: { id: 'q-1' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireTenantPrincipal.mockResolvedValue(principal)
  mocks.withTenantContext.mockImplementation(async (_p, cb) => cb({} as never))
})

describe('POST /api/queries/$id/visibility', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Authentication required', 401))

    const response = await call({ visibility: 'organization' })

    expect(response.status).toBe(401)
    expect(mocks.changeSavedQueryVisibilityForPrincipal).not.toHaveBeenCalled()
  })

  it('returns 422 for an unknown visibility value (the typed DTO rejects it before the DB call)', async () => {
    const response = await call({ visibility: 'public' })
    const body = await response.json()

    expect(response.status).toBe(422)
    expect(body.error).toBe('invalid_visibility')
    expect(mocks.changeSavedQueryVisibilityForPrincipal).not.toHaveBeenCalled()
  })

  it('returns 200 when the owner flips private→organization', async () => {
    const updated = { id: 'q-1', organizationId: 'org-1', userId: 'u-1', name: 'q', keywords: ['rust'], sources: ['github'], language: null, country: null, visibility: 'organization' as const, createdAt: new Date(), updatedAt: new Date() }
    mocks.changeSavedQueryVisibilityForPrincipal.mockResolvedValue(updated)

    const response = await call({ visibility: 'organization' })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.visibility).toBe('organization')
    expect(mocks.changeSavedQueryVisibilityForPrincipal).toHaveBeenCalledWith({}, principal, 'q-1', 'organization')
  })

  it('returns 404 (not 403) for a query the caller cannot see — anti-enumeration', async () => {
    mocks.changeSavedQueryVisibilityForPrincipal.mockRejectedValue(
      new SharedResourceError('not_found', 'gone', 404),
    )

    const response = await call({ visibility: 'organization' })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns 403 for a peer trying to flip on a row they could read but do not own', async () => {
    // Peer reads a shared row (visibility=organization), so findVisibleSavedQueryById
    // returns it. The next gate is resource:share, which requires the caller to be
    // the creator OR (for shared rows) an admin/owner. A non-admin peer fails.
    mocks.changeSavedQueryVisibilityForPrincipal.mockRejectedValue(
      new SharedResourceError('forbidden', 'Not allowed to change visibility on this saved query', 403),
    )

    const response = await call({ visibility: 'organization' })
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toBe('forbidden')
  })
})
