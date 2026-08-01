import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  getRemovalOperationsMetrics: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/repositories/profile-removal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/profile-removal')>()
  return { ...actual, getRemovalOperationsMetrics: mocks.getRemovalOperationsMetrics }
})

const { Route } = await import('~/routes/api/admin/metrics/trust')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request('https://app.test/api/admin/metrics/trust') })
}

const SAMPLE_METRICS = {
  totalRequests: 3,
  byStatus: { pending: 1, verified: 1, rejected: 0, expired: 1 },
  bySource: [{ source: 'github', count: 5 }],
  otherSourcesCount: 2,
  pendingAging: { underOneDay: 1, oneToSevenDays: 0, sevenToThirtyDays: 0, overThirtyDays: 0 },
  overduePendingCount: 0,
  activeSuppressions: 2,
  generatedAt: '2027-01-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRemovalOperationsMetrics.mockResolvedValue(SAMPLE_METRICS)
})

describe('GET /api/admin/metrics/trust', () => {
  it('returns the redacted removal operations metrics for a platform admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(SAMPLE_METRICS)
  })

  it('rejects a non-admin caller before computing any metrics', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.getRemovalOperationsMetrics).not.toHaveBeenCalled()
  })

  it('returns 500 without leaking the underlying error when the repository call throws', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getRemovalOperationsMetrics.mockRejectedValue(new Error('db connection reset by peer at 10.0.0.5'))

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('10.0.0.5')
  })
})
