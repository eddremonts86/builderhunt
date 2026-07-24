import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  getAccountingExport: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/billing/accounting-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/accounting-export')>()
  return { ...actual, getAccountingExport: mocks.getAccountingExport }
})

const { Route } = await import('./accounting-export')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(query = ''): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  return handler({ request: new Request(`https://app.test/api/admin/billing/accounting-export${query}`) })
}

const SAMPLE_RESULT = {
  windowStart: '2026-06-01T00:00:00.000Z',
  windowEnd: '2026-07-01T00:00:00.000Z',
  organizationsScanned: 5,
  grossRevenue: { basis: 'catalog_price_estimate', currency: 'usd', subscriptionCents: 1900, subscriptionCount: 1, packCents: 1500, packCount: 1, totalCents: 3400 },
  discounts: { available: false, reason: 'no discount amount is ever persisted' },
  tax: { available: false, reason: 'tax amount is never persisted' },
  refunds: { currency: 'usd', amountCents: 500, count: 1 },
  disputes: { currency: 'usd', amountCents: 0, count: 0, scopeNote: 'pack disputes only' },
  stripeFees: { available: false, reason: 'no fee data' },
  payout: { available: false, reason: 'no payout data' },
  outstandingInvoices: { available: false, reason: 'no invoice entity' },
  unexpiredCreditLiability: { units: 300 },
  providerCostByTierFeature: { available: false, reason: 'unpopulated table' },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/admin/billing/accounting-export', () => {
  it('returns the JSON export for a platform admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getAccountingExport.mockResolvedValue(SAMPLE_RESULT)

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(SAMPLE_RESULT)
    expect(mocks.getAccountingExport).toHaveBeenCalledWith({})
  })

  it('parses a ?month=YYYY-MM query param into explicit UTC window bounds', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getAccountingExport.mockResolvedValue(SAMPLE_RESULT)

    await callRoute('?month=2026-03')

    expect(mocks.getAccountingExport).toHaveBeenCalledWith({
      windowStart: new Date('2026-03-01T00:00:00.000Z'),
      windowEnd: new Date('2026-04-01T00:00:00.000Z'),
    })
  })

  it('ignores a malformed month param and falls back to the default window', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getAccountingExport.mockResolvedValue(SAMPLE_RESULT)

    await callRoute('?month=not-a-month')

    expect(mocks.getAccountingExport).toHaveBeenCalledWith({})
  })

  it('returns a CSV table when ?format=csv is given, with every metric represented as a row', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getAccountingExport.mockResolvedValue(SAMPLE_RESULT)

    const response = await callRoute('?format=csv')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(body).toContain('gross_revenue_total')
    expect(body).toContain('3400')
    expect(body).toContain('unexpired_credit_liability')
    expect(body).toContain('provider_cost_by_tier_feature')
  })

  it('rejects a non-admin caller before computing any export', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.getAccountingExport).not.toHaveBeenCalled()
  })

  it('returns 500 without leaking the raw error when the export throws unexpectedly', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.getAccountingExport.mockRejectedValue(new Error('connection refused at 10.0.4.9:5432'))

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('10.0.4.9')
  })
})
