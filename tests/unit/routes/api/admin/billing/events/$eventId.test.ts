import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  getBillingWebhookEventDetail: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal, auditPlatformAdminAction: mocks.auditPlatformAdminAction }
})

vi.mock('~/shared/lib/repositories/billing-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing-events')>()
  return { ...actual, getBillingWebhookEventDetail: mocks.getBillingWebhookEventDetail }
})

const { Route } = await import('~/routes/api/admin/billing/events/$eventId')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(eventId = 'row-1'): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request; params: { eventId: string } }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request(`https://app.test/api/admin/billing/events/${eventId}`), params: { eventId } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
})

describe('GET /api/admin/billing/events/$eventId', () => {
  it('rejects a non-admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))
    const response = await callRoute()
    expect(response.status).toBe(403)
    expect(mocks.getBillingWebhookEventDetail).not.toHaveBeenCalled()
  })

  it('404s for an unknown event id', async () => {
    mocks.getBillingWebhookEventDetail.mockResolvedValue(null)
    const response = await callRoute('does-not-exist')
    expect(response.status).toBe(404)
  })

  it('returns the detail and audits the view', async () => {
    mocks.getBillingWebhookEventDetail.mockResolvedValue({ id: 'row-1', replayEligible: true, replayEligibilityReason: 'Dead-lettered — ready to replay.' })
    const response = await callRoute('row-1')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'row-1', replayEligible: true })
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.billing.events.view', targetId: 'row-1' }),
    )
  })
})
