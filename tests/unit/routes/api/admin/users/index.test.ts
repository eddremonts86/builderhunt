import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  pagePlatformUsersWithBilling: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/repositories/platform-billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/platform-billing')>()
  return { ...actual, pagePlatformUsersWithBilling: mocks.pagePlatformUsersWithBilling }
})

const { Route } = await import('~/routes/api/admin/users/index')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request('https://app.test/api/admin/users') })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
})

describe('GET /api/admin/users', () => {
  it('rejects a non-admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))
    const response = await callRoute()
    expect(response.status).toBe(403)
    expect(mocks.pagePlatformUsersWithBilling).not.toHaveBeenCalled()
  })

  /**
   * The response is a `PageResult` now, not `{ users, pricing }`.
   *
   * Phase 3 plan 10 bounded this read: it used to return every user in the system and the page
   * filtered them in the browser. `pricing` is gone from the payload too — four constants that
   * `AdminUsersPage` already imports from `billing-shared.ts`, so the wire copy was never read.
   */
  it('returns a page of users, each with their billing summary', async () => {
    mocks.pagePlatformUsersWithBilling.mockResolvedValue({
      rows: [
        { userId: 'u-1', name: 'A', email: 'a@test.invalid', createdAt: '2027-01-01T00:00:00.000Z', billing: { organizationId: 'org-1', organizationName: 'Org', entitlementTier: 'pro', entitlementStatus: 'active', currentPeriodEnd: null, trialEndsAt: null, provenance: 'canonical' } },
        { userId: 'u-2', name: 'B', email: 'b@test.invalid', createdAt: '2027-01-01T00:00:00.000Z', billing: null },
      ],
      nextCursor: null,
      total: 2,
      facets: {},
    })
    const response = await callRoute()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.rows).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(body.rows[0].billing.provenance).toBe('canonical')
    expect(body.rows[1].billing).toBeNull()
  })

  /** The search reaches Postgres, so it covers every user rather than the loaded page. */
  it('passes the parsed search through to the paged read', async () => {
    mocks.pagePlatformUsersWithBilling.mockResolvedValue({ rows: [], nextCursor: null, total: 0, facets: {} })
    const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
    await handler({ request: new Request('https://app.test/api/admin/users?q=ada') })

    expect(mocks.pagePlatformUsersWithBilling).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'ada' }),
      expect.objectContaining({ cursor: null }),
    )
  })
})
