// GET /api/admin/builder-claims — auth boundary (plans/UI/tasks.md Wave 4 "Build platform-admin
// claim management projection"). Repository-level pagination/filter/DTO-redaction coverage lives in
// tests/unit/security/builder-claims-admin.test.ts; this file only proves the route itself denies a
// non-platform-admin caller before ever touching the repository.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  listBuilderClaimsForAdmin: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/repositories/builder-claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/builder-claims')>()
  return { ...actual, listBuilderClaimsForAdmin: mocks.listBuilderClaimsForAdmin }
})

const { Route } = await import('~/routes/api/admin/builder-claims/index')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

function callRoute(query = ''): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } }
  }).options.server.handlers.GET
  return handler({ request: new Request(`https://app.test/api/admin/builder-claims${query}`) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listBuilderClaimsForAdmin.mockResolvedValue({ rows: [], nextCursor: null })
})

describe('GET /api/admin/builder-claims', () => {
  it('rejects an unauthenticated caller before touching the repository', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Unauthorized', 401))
    const response = await callRoute()
    expect(response.status).toBe(401)
    expect(mocks.listBuilderClaimsForAdmin).not.toHaveBeenCalled()
  })

  it('rejects an authenticated but non-platform-admin caller (e.g. an organization admin)', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))
    const response = await callRoute()
    expect(response.status).toBe(403)
    expect(mocks.listBuilderClaimsForAdmin).not.toHaveBeenCalled()
  })

  it('passes parsed filters through to the repository for a platform admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    await callRoute('?status=verified,revoked&source=github&portfolioPublished=true&limit=10')
    expect(mocks.listBuilderClaimsForAdmin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: ['verified', 'revoked'],
      source: 'github',
      portfolioPublished: true,
      limit: 10,
    }))
  })

  it('rejects a cursor with only one of before/id supplied', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    const response = await callRoute('?before=2026-01-01T00:00:00.000Z')
    expect(response.status).toBe(422)
    expect(mocks.listBuilderClaimsForAdmin).not.toHaveBeenCalled()
  })
})
