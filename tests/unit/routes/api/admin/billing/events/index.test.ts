import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  listBillingWebhookEvents: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal, auditPlatformAdminAction: mocks.auditPlatformAdminAction }
})

vi.mock('~/shared/lib/repositories/billing-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing-events')>()
  return { ...actual, listBillingWebhookEvents: mocks.listBillingWebhookEvents }
})

const { Route } = await import('~/routes/api/admin/billing/events/index')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(query = ''): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request(`https://app.test/api/admin/billing/events/${query}`) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
  mocks.listBillingWebhookEvents.mockResolvedValue({ rows: [], nextCursor: null })
})

describe('GET /api/admin/billing/events', () => {
  it('rejects a non-admin before touching the repository', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))
    const response = await callRoute()
    expect(response.status).toBe(403)
    expect(mocks.listBillingWebhookEvents).not.toHaveBeenCalled()
  })

  it('rejects an invalid status filter', async () => {
    const response = await callRoute('?status=not-a-real-status')
    expect(response.status).toBe(400)
    expect(mocks.listBillingWebhookEvents).not.toHaveBeenCalled()
  })

  it('rejects an invalid date filter', async () => {
    const response = await callRoute('?receivedFrom=not-a-date')
    expect(response.status).toBe(400)
  })

  it('rejects a malformed cursor', async () => {
    const response = await callRoute('?cursor=garbage')
    expect(response.status).toBe(400)
  })

  it('passes valid filters through and audits the list action', async () => {
    const response = await callRoute('?status=failed&eventType=invoice.paid')
    expect(response.status).toBe(200)
    expect(mocks.listBillingWebhookEvents).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', eventType: 'invoice.paid' }),
      expect.anything(),
    )
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.billing.events.list' }),
    )
  })

  it('encodes nextCursor as a single opaque string', async () => {
    mocks.listBillingWebhookEvents.mockResolvedValue({ rows: [], nextCursor: { receivedAt: new Date('2027-01-01T00:00:00.000Z'), id: 'row-1' } })
    const response = await callRoute()
    const body = await response.json()
    expect(body.nextCursor).toBe('2027-01-01T00:00:00.000Z|row-1')
  })
})
