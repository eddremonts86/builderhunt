import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  runBillingWorker: vi.fn(),
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
  return { ...actual, runBillingWorker: mocks.runBillingWorker, createStripeEventRetriever: mocks.createStripeEventRetriever }
})

const { Route } = await import('./run-worker')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: new Request('https://app.test/api/admin/billing/run-worker', { method: 'POST' }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createStripeEventRetriever.mockReturnValue({ retrieveEvent: vi.fn() })
})

describe('POST /api/admin/billing/run-worker', () => {
  it('runs the worker and returns a summary for a platform admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.runBillingWorker.mockResolvedValue({
      claimedEvents: 3, processedEvents: 2, deferredEvents: 1, retryScheduledEvents: 0, deadLetteredEvents: 0, expiredGrants: 1, eventResults: [],
    })

    const response = await callRoute()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, claimedEvents: 3, processedEvents: 2, expiredGrants: 1 })
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.worker.run', targetId: 'billing' }),
    )
  })

  it('rejects a non-admin with the mapped platform-admin error response', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.runBillingWorker).not.toHaveBeenCalled()
  })

  it('maps an unexpected worker error to a generic 500', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.runBillingWorker.mockRejectedValue(new Error('db exploded'))

    const response = await callRoute()

    expect(response.status).toBe(500)
  })
})
