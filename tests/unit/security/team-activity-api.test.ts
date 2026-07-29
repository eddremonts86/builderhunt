// Plan 29 (activity-feed) task 5 — security suite for the
// /api/organizations/activity route.
//
// The principal-scoped repository is the only place this is
// enforced; these tests verify the route's contract on top.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  listActivity: vi.fn(),
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

vi.mock('~/shared/lib/repositories/activity', () => ({
  listActivity: mocks.listActivity,
}))

const { Route } = await import('~/routes/api/organizations/activity')
const { SharedResourceError } = await import('~/shared/lib/shared-resources/contracts')

const principal = { userId: 'u-1', organizationId: 'org-1', role: 'owner' as const, requestId: 'r-1' }

function call(url: string): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { GET: (a: { request: Request }) => Promise<Response> } } }
  }).options.server.handlers.GET
  return handler({ request: new Request(url) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireTenantPrincipal.mockResolvedValue(principal)
  mocks.withTenantContext.mockImplementation(async (_p, cb) => cb({} as never))
  mocks.listActivity.mockResolvedValue({ rows: [], nextCursor: null })
})

describe('GET /api/organizations/activity', () => {
  it('returns 401 for an unauthenticated caller', async () => {
    const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Authentication required', 401))
    const response = await call('https://app.test/api/organizations/activity')
    expect(response.status).toBe(401)
    expect(mocks.listActivity).not.toHaveBeenCalled()
  })

  it('returns 422 for an invalid cursor (id without before)', async () => {
    const response = await call('https://app.test/api/organizations/activity?id=550e8400-e29b-41d4-a716-446655440000')
    expect(response.status).toBe(422)
    expect(mocks.listActivity).not.toHaveBeenCalled()
  })

  it('returns the activity rows and a serializable cursor', async () => {
    const occurredAt = new Date('2026-07-29T15:00:00Z')
    mocks.listActivity.mockResolvedValue({
      rows: [
        {
          id: 'row-1',
          type: 'saved_query_created',
          version: 1,
          actorUserId: 'u-1',
          targetKey: 'q-1',
          metadata: { queryId: 'q-1', queryName: 'rust', visibility: 'private' },
          occurredAt: occurredAt.toISOString(),
          display: 'Created search "rust"',
        },
      ],
      nextCursor: { occurredAt: occurredAt.toISOString(), id: 'row-1' },
    })
    const response = await call('https://app.test/api/organizations/activity')
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].display).toBe('Created search "rust"')
    expect(body.nextCursor).toEqual({ before: occurredAt.toISOString(), id: 'row-1' })
  })

  it('returns 403 when the activity error is a SharedResourceError (forbidden)', async () => {
    mocks.listActivity.mockRejectedValue(
      new SharedResourceError('forbidden', 'Not allowed', 403),
    )
    const response = await call('https://app.test/api/organizations/activity')
    expect(response.status).toBe(403)
  })

  it('does not accept an organizationId parameter — the active org is the principal\'s only', async () => {
    mocks.listActivity.mockResolvedValue({ rows: [], nextCursor: null })
    // Even with an explicit ?organizationId=, the route uses the
    // principal. The repository is the only place org is named,
    // and the principal.organizationId is the only value it sees.
    await call('https://app.test/api/organizations/activity?organizationId=org-attacker')
    const [calledPrincipal, cb] = mocks.withTenantContext.mock.calls[0]
    expect(calledPrincipal).toBe(principal)
    await cb({})
    // The listActivity call gets the principal, NOT any user-supplied org
    expect(mocks.listActivity).toHaveBeenCalledWith({}, principal, expect.any(Object))
  })
})
