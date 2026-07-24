import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingReconciliationRuns, billingSellerProfiles, billingWebhookEvents } from '../db/schema'

const mocks = vi.hoisted(() => ({
  listWorkerOrganizationIds: vi.fn(),
  withWorkerOrganization: vi.fn(),
  listGracePeriodBillingSubscriptions: vi.fn(),
  listBillingRefunds: vi.fn(),
  listOrganizationDisputes: vi.fn(),
  listRiskExceptions: vi.fn(),
  isLiveMode: vi.fn(),
}))

vi.mock('../repositories/billing-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories/billing-worker')>()
  return {
    ...actual,
    listWorkerOrganizationIds: mocks.listWorkerOrganizationIds,
    withWorkerOrganization: mocks.withWorkerOrganization,
    listGracePeriodBillingSubscriptions: mocks.listGracePeriodBillingSubscriptions,
  }
})

vi.mock('../repositories/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories/billing')>()
  return { ...actual, listBillingRefunds: mocks.listBillingRefunds }
})

vi.mock('./disputes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./disputes')>()
  return { ...actual, listOrganizationDisputes: mocks.listOrganizationDisputes }
})

vi.mock('./risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./risk')>()
  return { ...actual, listRiskExceptions: mocks.listRiskExceptions }
})

vi.mock('./stripe-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stripe-client')>()
  return { ...actual, isLiveMode: mocks.isLiveMode }
})

const { getBillingOperationsMetrics } = await import('./operations-metrics')

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `ops-metrics-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('operations_metrics')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

/** Matches `operations-metrics.ts`'s own `transaction.select({id}).from(...).where(...)` shape for the stale-reservations count — every test not specifically asserting on that count gets an empty result by default. */
function fakeWorkerTransaction() {
  return { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isLiveMode.mockReturnValue(false)
  mocks.listWorkerOrganizationIds.mockResolvedValue([])
  mocks.withWorkerOrganization.mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(fakeWorkerTransaction()))
  mocks.listGracePeriodBillingSubscriptions.mockResolvedValue([])
  mocks.listBillingRefunds.mockResolvedValue([])
  mocks.listOrganizationDisputes.mockResolvedValue([])
  mocks.listRiskExceptions.mockResolvedValue([])
})

describe('getBillingOperationsMetrics — real-DB-backed pieces (webhooks, configuration, reconciliation)', () => {
  it('counts the current webhook backlog by status from a real database', async () => {
    await db.insert(billingWebhookEvents).values([
      { id: uniqueId('evt'), livemode: false, stripeEventId: uniqueId('stripe'), apiVersion: '2024-01-01', objectType: 'checkout.session', eventType: 'checkout.session.completed', status: 'pending', payloadEncrypted: 'x' },
      { id: uniqueId('evt'), livemode: false, stripeEventId: uniqueId('stripe'), apiVersion: '2024-01-01', objectType: 'checkout.session', eventType: 'checkout.session.completed', status: 'pending', payloadEncrypted: 'x' },
      { id: uniqueId('evt'), livemode: false, stripeEventId: uniqueId('stripe'), apiVersion: '2024-01-01', objectType: 'invoice', eventType: 'invoice.paid', status: 'failed', payloadEncrypted: 'x' },
      { id: uniqueId('evt'), livemode: false, stripeEventId: uniqueId('stripe'), apiVersion: '2024-01-01', objectType: 'invoice', eventType: 'invoice.paid', status: 'processed', payloadEncrypted: 'x' },
    ])

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.webhooks).toEqual({ pending: 2, processing: 0, failed: 1, ignored: 0, processed: 1 })
  })

  it('reports no seller configuration recorded as null, not a fabricated version', async () => {
    const metrics = await getBillingOperationsMetrics({ platform: db })
    expect(metrics.configuration).toBeNull()
  })

  it('reads the current seller configuration version once one exists', async () => {
    const userId = uniqueId('user')
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    await db.insert(billingSellerProfiles).values({
      id: randomUUID(), version: 1, legalName: 'Acme ApS', publicBusinessAddress: 'Somewhere 1, Copenhagen',
      establishmentCountry: 'DK', approvedTaxIds: [], supportEmail: 'support@test.com', statementDescriptor: 'ACME',
      countryAllowlist: ['DK'], taxRegistrations: [], effectiveAt: new Date('2026-01-01T00:00:00Z'), createdByUserId: userId,
    })

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.configuration).toMatchObject({ version: 1, statementDescriptor: 'ACME', supportEmail: 'support@test.com' })
  })

  it('reports reconciliation as not-yet-available (null) when no run has ever executed', async () => {
    const metrics = await getBillingOperationsMetrics({ platform: db })
    expect(metrics.reconciliation.lastRun).toBeNull()
  })

  it('surfaces the most recent reconciliation run once one exists', async () => {
    await db.insert(billingReconciliationRuns).values({
      id: uniqueId('recon'), windowStart: new Date('2026-01-01T00:00:00Z'), windowEnd: new Date('2026-01-02T00:00:00Z'),
      countsChecked: {}, result: 'clean',
    })

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.reconciliation.lastRun).toMatchObject({ result: 'clean' })
  })

  it('surfaces the MOST RECENT run by createdAt, not an arbitrary or oldest one, when several exist', async () => {
    // Explicit far-future createdAt values so this assertion is never accidentally satisfied by
    // wall-clock-timestamped rows other tests in this same disposable database may have inserted.
    await db.insert(billingReconciliationRuns).values([
      { id: uniqueId('recon'), windowStart: new Date('2031-01-01T00:00:00Z'), windowEnd: new Date('2031-01-02T00:00:00Z'), countsChecked: {}, result: 'clean', createdAt: new Date('2031-01-02T00:00:00Z') },
      { id: uniqueId('recon'), windowStart: new Date('2031-02-01T00:00:00Z'), windowEnd: new Date('2031-02-02T00:00:00Z'), countsChecked: {}, result: 'mismatches_found', createdAt: new Date('2031-02-02T00:00:00Z') },
      { id: uniqueId('recon'), windowStart: new Date('2031-01-15T00:00:00Z'), windowEnd: new Date('2031-01-16T00:00:00Z'), countsChecked: {}, result: 'repairs_applied', createdAt: new Date('2031-01-16T00:00:00Z') },
    ])

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.reconciliation.lastRun).toMatchObject({ result: 'mismatches_found', windowEnd: '2031-02-02T00:00:00.000Z' })
  })

  it('reports cost/margin as explicitly unavailable — never a fabricated number', async () => {
    const metrics = await getBillingOperationsMetrics({ platform: db })
    expect(metrics.costMargin).toEqual({ available: false })
  })
})

describe('getBillingOperationsMetrics — cross-organization aggregation', () => {
  it('sums grace/refund/dispute/risk-exception/stale-reservation counts across every organization scanned', async () => {
    mocks.listWorkerOrganizationIds.mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }])
    mocks.listGracePeriodBillingSubscriptions.mockImplementation(async (_tx: unknown, organizationId: string) =>
      organizationId === 'org-a' ? [{ stripeSubscriptionId: 'sub_1', gracePeriodEndsAt: new Date(), paymentBlockedAt: null }] : [],
    )
    mocks.listBillingRefunds.mockImplementation(async (_tx: unknown, organizationId: string) =>
      organizationId === 'org-a'
        ? [{ id: 'r1', organizationId, policyDecision: 'full_unused_pack', amountCents: 100, state: 'pending', createdAt: new Date() }]
        : [{ id: 'r2', organizationId, policyDecision: 'full_unused_pack', amountCents: 200, state: 'succeeded', createdAt: new Date() }],
    )
    mocks.listOrganizationDisputes.mockImplementation(async (_tx: unknown, organizationId: string) =>
      organizationId === 'org-b' ? [{ id: 'd1', organizationId, outcome: 'open' } as never] : [],
    )
    mocks.listRiskExceptions.mockImplementation(async (organizationId: string) =>
      organizationId === 'org-a' ? [{ id: 'x1', organizationId, revokedAt: null, expiresAt: null } as never] : [],
    )
    mocks.withWorkerOrganization.mockImplementation(async (organizationId: string, fn: (tx: unknown) => unknown) => {
      const tx = { select: () => ({ from: () => ({ where: () => Promise.resolve(organizationId === 'org-b' ? [{ id: 'res-1' }] : []) }) }) }
      return fn(tx)
    })

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.organizationsScanned).toBe(2)
    expect(metrics.grace.organizationsInGrace).toBe(1)
    expect(metrics.refunds.pendingRequests).toBe(1)
    expect(metrics.disputes.open).toBe(1)
    expect(metrics.riskExceptions.active).toBe(1)
    expect(metrics.creditInvariants.staleReservations).toBe(1)
  })

  it('never counts a revoked or expired risk exception as active', async () => {
    mocks.listWorkerOrganizationIds.mockResolvedValue([{ id: 'org-a' }])
    mocks.listRiskExceptions.mockResolvedValue([
      { id: 'x1', organizationId: 'org-a', revokedAt: new Date(), expiresAt: null } as never,
      { id: 'x2', organizationId: 'org-a', revokedAt: null, expiresAt: new Date('2020-01-01T00:00:00Z') } as never,
    ])

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.riskExceptions.active).toBe(0)
  })

  it('reflects the live/test mode flag from isLiveMode()', async () => {
    mocks.isLiveMode.mockReturnValue(true)
    const metrics = await getBillingOperationsMetrics({ platform: db })
    expect(metrics.liveMode).toBe(true)
  })
})
