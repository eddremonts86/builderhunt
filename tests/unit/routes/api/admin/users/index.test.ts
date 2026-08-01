import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  listAllUsersWithBilling: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing')>()
  return { ...actual, listAllUsersWithBilling: mocks.listAllUsersWithBilling }
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
    expect(mocks.listAllUsersWithBilling).not.toHaveBeenCalled()
  })

  it('returns each user with their billing summary', async () => {
    mocks.listAllUsersWithBilling.mockResolvedValue([
      { userId: 'u-1', name: 'A', email: 'a@test.invalid', createdAt: '2027-01-01T00:00:00.000Z', plan: 'pro', status: 'active', planEndsAt: null, billing: { organizationId: 'org-1', organizationName: 'Org', entitlementTier: 'pro', entitlementStatus: 'active', currentPeriodEnd: null, trialEndsAt: null, provenance: 'canonical' } },
      { userId: 'u-2', name: 'B', email: 'b@test.invalid', createdAt: '2027-01-01T00:00:00.000Z', plan: 'free', status: 'active', planEndsAt: null, billing: null },
    ])
    const response = await callRoute()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.users).toHaveLength(2)
    expect(body.users[0].billing.provenance).toBe('canonical')
    expect(body.users[1].billing).toBeNull()
  })
})
