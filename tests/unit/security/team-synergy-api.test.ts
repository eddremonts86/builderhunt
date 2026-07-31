// /api/builders/$builderId/synergy — security suite.
//
// Regression coverage for the doc/behavior mismatch found during the 2026-07-31 phase-1 audit:
// the route's own comment says an orgListId the principal can't see returns 404
// ("anti-enumeration"), but the code silently returned `{ teamSource } -> []` teammates, which
// then always hit the `teammates.length < 2` branch and returned 200 { teamTooSmall: true } — the
// documented 404 path was never actually reachable, and nothing tested it either way.
//
// Verifies:
// - An orgListId the principal cannot see (foreign org, or nonexistent) returns 404, not
//   teamTooSmall.
// - A visible list with < 2 usable members still returns 200 { teamTooSmall: true } (this case
//   must NOT regress into a 404 — it's a real, visible list, just a small one).
// - 404 when the candidate builder itself isn't tracked by this organization.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  findOrganizationBuilderByIdentity: vi.fn(),
  listOrganizationBuildersForTeamAggregate: vi.fn(),
  findVisibleBuilderListById: vi.fn(),
  listItemsForList: vi.fn(),
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

vi.mock('~/shared/lib/repositories/organization-builders', () => ({
  findOrganizationBuilderByIdentity: mocks.findOrganizationBuilderByIdentity,
  listOrganizationBuildersForTeamAggregate: mocks.listOrganizationBuildersForTeamAggregate,
}))

vi.mock('~/shared/lib/repositories/builder-lists', () => ({
  findVisibleBuilderListById: mocks.findVisibleBuilderListById,
  listItemsForList: mocks.listItemsForList,
}))

const { Route } = await import('~/routes/api/builders/$builderId/synergy')

const principal = { userId: 'u-1', organizationId: 'org-1', role: 'owner' as const, requestId: 'r-1' }

const CANDIDATE = {
  identityId: 'cand-1',
  username: 'candidate',
  source: 'github',
  bio: null,
  language: 'rust',
  followersCount: 10,
  privateMetadata: null,
}

function call(builderId: string, body?: unknown): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { POST: (a: { request: Request; params: { builderId: string } }) => Promise<Response> } } }
  }).options.server.handlers.POST
  const init: RequestInit = body !== undefined
    ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
    : { method: 'POST' }
  return handler({ request: new Request(`https://app.test/api/builders/${builderId}/synergy`, init), params: { builderId } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireTenantPrincipal.mockResolvedValue(principal)
  mocks.withTenantContext.mockImplementation(async (_p, cb) => cb({} as never))
  mocks.findOrganizationBuilderByIdentity.mockResolvedValue(CANDIDATE)
})

describe('POST /api/builders/$builderId/synergy — orgListId team source', () => {
  it('returns 404 for an orgListId the principal cannot see, not teamTooSmall', async () => {
    mocks.findVisibleBuilderListById.mockResolvedValue(null)

    const response = await call('cand-1', { teamSource: { orgListId: 'list-not-mine' } })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toBe('Builder list not found')
    expect(mocks.listItemsForList).not.toHaveBeenCalled()
  })

  it('returns 200 teamTooSmall for a visible list with fewer than 2 usable members', async () => {
    mocks.findVisibleBuilderListById.mockResolvedValue({ id: 'list-1', organizationId: 'org-1' })
    mocks.listItemsForList.mockResolvedValue([{ builderIdentityId: 'cand-1' }])

    const response = await call('cand-1', { teamSource: { orgListId: 'list-1' } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ teamTooSmall: true })
  })
})

describe('POST /api/builders/$builderId/synergy — candidate lookup', () => {
  it('returns 404 when the candidate builder is not tracked by this organization', async () => {
    mocks.findOrganizationBuilderByIdentity.mockResolvedValue(null)

    const response = await call('unknown-builder')
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toBe('Builder not found')
  })
})
