import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  replayBillingWebhookEvent: vi.fn(),
  createStripeEventRetriever: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return {
    ...actual,
    requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal,
    auditPlatformAdminAction: mocks.auditPlatformAdminAction,
  }
})

vi.mock('~/shared/lib/billing/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/worker')>()
  return { ...actual, replayBillingWebhookEvent: mocks.replayBillingWebhookEvent, createStripeEventRetriever: mocks.createStripeEventRetriever }
})

const { Route } = await import('./replay')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')
const { ReplayError } = await import('~/shared/lib/billing/worker')

async function callRoute(eventId = 'row-1'): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request; params: { eventId: string } }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: new Request(`https://app.test/api/admin/billing/events/${eventId}/replay`, { method: 'POST' }), params: { eventId } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createStripeEventRetriever.mockReturnValue({ retrieveEvent: vi.fn() })
})

describe('POST /api/admin/billing/events/$eventId/replay', () => {
  it('replays an event for a platform admin and audits the action', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.replayBillingWebhookEvent.mockResolvedValue({ eventRowId: 'row-1', stripeEventId: 'evt_1', result: 'processed', detail: 'ok' })

    const response = await callRoute('row-1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ eventRowId: 'row-1', stripeEventId: 'evt_1', result: 'processed', detail: 'ok' })
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.billing.events.replay', targetId: 'row-1' }),
    )
  })

  it('rejects a non-admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRoute('row-1')

    expect(response.status).toBe(403)
    expect(mocks.replayBillingWebhookEvent).not.toHaveBeenCalled()
  })

  it('maps a ReplayError (unknown event row) to 404', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.replayBillingWebhookEvent.mockRejectedValue(new ReplayError('No webhook event found', 'not_found'))

    const response = await callRoute('does-not-exist')

    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('not_found')
  })

  it('maps an unexpected error to a generic 500', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.replayBillingWebhookEvent.mockRejectedValue(new Error('db exploded'))

    const response = await callRoute('row-1')

    expect(response.status).toBe(500)
  })
})
