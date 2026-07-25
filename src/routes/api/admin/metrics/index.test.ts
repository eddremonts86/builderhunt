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

const { Route } = await import('./index')
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
  it('includes a billing section with computed alerts for a platform admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.billing).toMatchObject({ ...SAMPLE_BILLING_METRICS, alerts: ['1 webhook event(s) permanently failed'] })
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

  it('surfaces no alerts when the billing metrics are fully clean', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getBillingOperationsMetrics.mockResolvedValue({ ...SAMPLE_BILLING_METRICS, webhooks: { ...SAMPLE_BILLING_METRICS.webhooks, failed: 0 } })

    const response = await callRoute()
    const body = await response.json()

    expect(body.billing.alerts).toEqual([])
  })

  it('rejects a non-admin caller before computing any metrics', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.getBillingOperationsMetrics).not.toHaveBeenCalled()
  })
})
