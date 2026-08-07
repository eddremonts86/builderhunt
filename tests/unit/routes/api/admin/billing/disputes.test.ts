import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  pageOrganizationDisputes: vi.fn(),
  withPlatformOrganization: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/billing/disputes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/disputes')>()
  return { ...actual, pageOrganizationDisputes: mocks.pageOrganizationDisputes }
})

vi.mock('~/shared/lib/repositories/billing-risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing-risk')>()
  return { ...actual, withPlatformOrganization: mocks.withPlatformOrganization }
})

const { Route } = await import('~/routes/api/admin/billing/disputes')

const PAGE = { rows: [{ id: 'dispute-1' }], nextCursor: null, total: 1, facets: {} }

async function get(url: string): Promise<Response> {
  const handlers = (Route as unknown as {
    options: { server: { handlers: Record<string, (args: { request: Request }) => Promise<Response>> } }
  }).options.server.handlers
  return handlers.GET({ request: new Request(url) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.withPlatformOrganization.mockImplementation((_organizationId: string, fn: (tx: unknown) => unknown) => fn({}))
  mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
})

describe('GET /api/admin/billing/disputes', () => {
  it('authenticates before it parses anything', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new Error('unauthorized'))

    // No organization filter either — a parse error answered first would tell an anonymous caller
    // which parameters the endpoint takes.
    const response = await get('https://app.test/api/admin/billing/disputes')

    expect(response.status).toBe(500) // a bare Error is not a PlatformAdminAuthorizationError
    expect(mocks.pageOrganizationDisputes).not.toHaveBeenCalled()
  })

  it('requires the organization filter', async () => {
    const response = await get('https://app.test/api/admin/billing/disputes')

    expect(response.status).toBe(400)
    expect(mocks.pageOrganizationDisputes).not.toHaveBeenCalled()
  })

  /** RLS can only be scoped to one organization, and two chips saying otherwise would be a lie. */
  it('refuses two organizations rather than picking one', async () => {
    const response = await get(
      'https://app.test/api/admin/billing/disputes?filter.organizationId=org-1&filter.organizationId=org-2',
    )

    expect(response.status).toBe(400)
    expect(mocks.pageOrganizationDisputes).not.toHaveBeenCalled()
  })

  it('scopes the read to the filtered organization and returns a page', async () => {
    mocks.pageOrganizationDisputes.mockResolvedValue(PAGE)

    const response = await get('https://app.test/api/admin/billing/disputes?filter.organizationId=org-1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(PAGE)
    expect(mocks.withPlatformOrganization).toHaveBeenCalledWith('org-1', expect.any(Function))
  })

  it('answers 405 for a write — this queue is read-only by design', async () => {
    const handlers = (Route as unknown as {
      options: { server: { handlers: Record<string, (args: { request: Request }) => Promise<Response>> } }
    }).options.server.handlers
    const response = await handlers.ANY({
      request: new Request('https://app.test/api/admin/billing/disputes', { method: 'POST' }),
    })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })
})
