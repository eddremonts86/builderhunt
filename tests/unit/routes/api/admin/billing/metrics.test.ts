import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  getBillingOperationsMetrics: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/billing/operations-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/operations-metrics')>()
  return { ...actual, getBillingOperationsMetrics: mocks.getBillingOperationsMetrics }
})

const { Route } = await import('~/routes/api/admin/billing/metrics')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request('https://app.test/api/admin/billing/metrics') })
}

const SAMPLE_METRICS = {
  liveMode: false,
  configuration: { version: 1, effectiveAt: '2026-01-01T00:00:00.000Z', statementDescriptor: 'BUILDERHUNT', supportEmail: 'support@test.com' },
  webhooks: { pending: 0, processing: 0, failed: 0, ignored: 0, processed: 10 },
  grace: { organizationsInGrace: 0 },
  refunds: { pendingRequests: 0 },
  disputes: { open: 0 },
  riskExceptions: { active: 0 },
  creditInvariants: { staleReservations: 0 },
  reconciliation: { lastRun: null },
  costMargin: { available: false },
  organizationsScanned: 3,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/admin/billing/metrics', () => {
  it('returns the aggregate metrics for a platform admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getBillingOperationsMetrics.mockResolvedValue(SAMPLE_METRICS)

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(SAMPLE_METRICS)
  })

  it('rejects a non-admin caller before computing any metrics', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.getBillingOperationsMetrics).not.toHaveBeenCalled()
  })

  it('propagates a 401 for a signed-out caller', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Authentication required', 401))

    const response = await callRoute()

    expect(response.status).toBe(401)
  })

  it('returns 500 if the metrics composer throws unexpectedly, never leaking the raw error', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getBillingOperationsMetrics.mockRejectedValue(new Error('db connection reset by peer at 10.0.4.2'))

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('10.0.4.2')
  })
})
