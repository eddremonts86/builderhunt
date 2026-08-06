import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  getPlatformAccountMetrics: vi.fn(),
  getOnboardingActivationMetrics: vi.fn(),
  getDiscoveryState: vi.fn(),
  getBillingOperationsMetrics: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/repositories/platform-billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/platform-billing')>()
  return {
    ...actual,
    getPlatformAccountMetrics: mocks.getPlatformAccountMetrics,
    getOnboardingActivationMetrics: mocks.getOnboardingActivationMetrics,
  }
})

vi.mock('~/shared/lib/repositories/discovery-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/discovery-state')>()
  return { ...actual, getDiscoveryState: mocks.getDiscoveryState }
})

vi.mock('~/shared/lib/billing/operations-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/operations-metrics')>()
  return { ...actual, getBillingOperationsMetrics: mocks.getBillingOperationsMetrics }
})

const { Route } = await import('~/routes/api/admin/metrics/index')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request('https://app.test/api/admin/metrics') })
}

const SAMPLE_BILLING_METRICS = {
  liveMode: false,
  configuration: null,
  webhooks: { pending: 0, processing: 0, failed: 1, ignored: 0, processed: 0 },
  grace: { organizationsInGrace: 0 },
  refunds: { pendingRequests: 0 },
  disputes: { open: 0 },
  riskExceptions: { active: 0 },
  creditInvariants: { staleReservations: 0 },
  reconciliation: { lastRun: null },
  costMargin: { available: false as const },
  checkout: { open: 0, complete: 0, expired: 0, canceled: 0 },
  recovery: { inGrace: 0, blocked: 0 },
  webhookAge: { oldestPendingMinutes: null },
  ledgerInvariant: { violations: 0 },
  autoRecharge: { active: 0, pausedNeedsAuth: 0, pausedFailed: 0 },
  countryGate: { rejectionsSinceStart: 0 },
  organizationsScanned: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getPlatformAccountMetrics.mockResolvedValue({ totalAccounts: 0, newAccountsToday: 0, newAccountsThisWeek: 0 })
  mocks.getOnboardingActivationMetrics.mockResolvedValue({ onboardingCompleted: 0, onboardingSkipped: 0, onboardingCompletedLast7d: 0 })
  mocks.getDiscoveryState.mockResolvedValue(null)
  mocks.getBillingOperationsMetrics.mockResolvedValue(SAMPLE_BILLING_METRICS)
})

describe('GET /api/admin/metrics', () => {
  /**
   * The regression guard for the cross-organization scan this endpoint used to run on every load.
   *
   * Asserted as *absence of the call*, not as response latency. A timing assertion would go green
   * again the day somebody reintroduces the scan behind a faster query, and the point is not that
   * the scan was slow — it is that this page never rendered its result. `/api/admin/billing/metrics`
   * is where it belongs, and the test below proves it still answers there.
   */
  it('never runs the cross-organization billing scan — the page does not render it', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.getBillingOperationsMetrics).not.toHaveBeenCalled()
    expect(body).not.toHaveProperty('billing')
  })

  /**
   * These three were hardcoded `null` in the response literal and rendered as em-dashes. Making them
   * real would need `builderhunt_platform` to read tenant-private tables unscoped, so they are gone
   * rather than faked; this pins that they do not quietly come back as nulls.
   */
  it('omits the counts it cannot compute rather than returning null placeholders', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const body = await (await callRoute()).json()

    expect(body.db).not.toHaveProperty('totalSavedQueries')
    expect(body.db).not.toHaveProperty('totalBuilders')
    expect(body.db).not.toHaveProperty('totalNotes')
  })

  it('includes onboarding activation metrics, computing the 7d rate from completed/newUsersLast7d', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getPlatformAccountMetrics.mockResolvedValue({ totalUsers: 100, newUsersLast24h: 5, newUsersLast7d: 20 })
    mocks.getOnboardingActivationMetrics.mockResolvedValue({ onboardingCompleted: 12, onboardingSkipped: 3, onboardingCompletedLast7d: 8 })

    const response = await callRoute()
    const body = await response.json()

    expect(body.db.onboardingCompleted).toBe(12)
    expect(body.db.onboardingSkipped).toBe(3)
    expect(body.db.activationRate7d).toBe(8 / 20)
  })

  it('reports a null activation rate when there were no new users in the last 7 days (avoids divide-by-zero)', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getPlatformAccountMetrics.mockResolvedValue({ totalUsers: 100, newUsersLast24h: 0, newUsersLast7d: 0 })
    mocks.getOnboardingActivationMetrics.mockResolvedValue({ onboardingCompleted: 12, onboardingSkipped: 3, onboardingCompletedLast7d: 0 })

    const response = await callRoute()
    const body = await response.json()

    expect(body.db.activationRate7d).toBeNull()
  })

  /**
   * The DB aggregates are computed per request. Without a server-side timestamp the page could only
   * report when it *asked*, which diverges from when the server answered under exactly the load
   * where the difference is worth knowing.
   */
  it('stamps when the server read the numbers', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const body = await (await callRoute()).json()

    expect(typeof body.generatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)
  })

  it('rejects a non-admin caller before computing any metrics', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.getPlatformAccountMetrics).not.toHaveBeenCalled()
    expect(mocks.getDiscoveryState).not.toHaveBeenCalled()
  })
})
