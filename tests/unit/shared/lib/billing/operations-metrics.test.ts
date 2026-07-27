import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, billingAutoRechargeRules, billingCheckoutAttempts, billingLedgerEntries, billingReconciliationRuns, billingSellerProfiles, billingSubscriptions, billingWebhookEvents } from '~/shared/lib/db/schema'

const mocks = vi.hoisted(() => ({
  listWorkerOrganizationIds: vi.fn(),
  withWorkerOrganization: vi.fn(),
  listGracePeriodBillingSubscriptions: vi.fn(),
  listBillingRefunds: vi.fn(),
  listActiveBillingCreditGrants: vi.fn(),
  listOrganizationDisputes: vi.fn(),
  listRiskExceptions: vi.fn(),
  isLiveMode: vi.fn(),
}))

vi.mock('~/shared/lib/repositories/billing-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing-worker')>()
  return {
    ...actual,
    listWorkerOrganizationIds: mocks.listWorkerOrganizationIds,
    withWorkerOrganization: mocks.withWorkerOrganization,
    listGracePeriodBillingSubscriptions: mocks.listGracePeriodBillingSubscriptions,
  }
})

vi.mock('~/shared/lib/repositories/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/billing')>()
  return { ...actual, listBillingRefunds: mocks.listBillingRefunds, listActiveBillingCreditGrants: mocks.listActiveBillingCreditGrants }
})

vi.mock('~/shared/lib/billing/disputes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/disputes')>()
  return { ...actual, listOrganizationDisputes: mocks.listOrganizationDisputes }
})

vi.mock('~/shared/lib/billing/risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/risk')>()
  return { ...actual, listRiskExceptions: mocks.listRiskExceptions }
})

vi.mock('~/shared/lib/billing/stripe-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/stripe-client')>()
  return { ...actual, isLiveMode: mocks.isLiveMode }
})

const { evaluateBillingAlerts, getBillingOperationsMetrics } = await import('~/shared/lib/billing/operations-metrics')

const CLEAN_METRICS_BASE = {
  liveMode: false,
  configuration: null,
  webhooks: { pending: 0, processing: 0, failed: 0, ignored: 0, processed: 0 },
  grace: { organizationsInGrace: 0 },
  refunds: { pendingRequests: 0 },
  disputes: { open: 0 },
  riskExceptions: { active: 0 },
  creditInvariants: { staleReservations: 0 },
  reconciliation: { lastRun: null as { windowEnd: string; result: string } | null },
  costMargin: { available: false as const },
  checkout: { open: 0, complete: 0, expired: 0, canceled: 0 },
  recovery: { inGrace: 0, blocked: 0 },
  webhookAge: { oldestPendingMinutes: null as number | null },
  ledgerInvariant: { violations: 0 },
  autoRecharge: { active: 0, pausedNeedsAuth: 0, pausedFailed: 0 },
  countryGate: { rejectionsSinceStart: 0 },
  organizationsScanned: 0,
}

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

/** A thenable that also exposes `.limit()` — matches BOTH shapes `operations-metrics.ts` uses on a raw `transaction.select({...}).from(...).where(...)` result: awaited directly (stale reservations, auto-recharge rules) or chained with `.limit(1)` (the payment-blocked check). */
function whereResult(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & { limit: (n: number) => Promise<unknown[]> }
  promise.limit = (n: number) => Promise.resolve(rows.slice(0, n))
  return promise
}

/** Matches `operations-metrics.ts`'s own `transaction.select({id}).from(...).where(...)` shape — every test not specifically asserting on one of these raw queries gets an empty result by default. */
function fakeWorkerTransaction() {
  return { select: () => ({ from: () => ({ where: () => whereResult([]) }) }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isLiveMode.mockReturnValue(false)
  mocks.listWorkerOrganizationIds.mockResolvedValue([])
  mocks.withWorkerOrganization.mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(fakeWorkerTransaction()))
  mocks.listGracePeriodBillingSubscriptions.mockResolvedValue([])
  mocks.listBillingRefunds.mockResolvedValue([])
  mocks.listActiveBillingCreditGrants.mockResolvedValue([])
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
      const tx = { select: () => ({ from: () => ({ where: () => whereResult(organizationId === 'org-b' ? [{ id: 'res-1' }] : []) }) }) }
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

/** A `.select().from(table).where(...)` fake that returns different rows depending on WHICH table object was queried (compared by reference) — the new §10 metrics (checkout/auto-recharge/blocked/ledger) all issue distinct raw queries inside the same per-organization transaction, so the single generic `fakeWorkerTransaction()` above (same result for every table) can't distinguish them. */
function tableAwareFakeTransaction(rowsByTable: Map<unknown, unknown[]>) {
  return {
    select: () => ({
      from: (table: unknown) => ({ where: () => whereResult(rowsByTable.get(table) ?? []) }),
    }),
  }
}

describe('getBillingOperationsMetrics — §10 checkout/recovery/auto-recharge/ledger metrics', () => {
  it('counts checkout attempts by status across every organization scanned', async () => {
    mocks.listWorkerOrganizationIds.mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }])
    mocks.withWorkerOrganization.mockImplementation(async (organizationId: string, fn: (tx: unknown) => unknown) =>
      fn(tableAwareFakeTransaction(new Map([
        [billingCheckoutAttempts, organizationId === 'org-a' ? [{ status: 'complete' }, { status: 'expired' }] : [{ status: 'complete' }]],
      ]))),
    )

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.checkout).toEqual({ open: 0, complete: 2, expired: 1, canceled: 0 })
  })

  it('counts auto-recharge rule states across every organization scanned', async () => {
    mocks.listWorkerOrganizationIds.mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }])
    mocks.withWorkerOrganization.mockImplementation(async (organizationId: string, fn: (tx: unknown) => unknown) =>
      fn(tableAwareFakeTransaction(new Map([
        [billingAutoRechargeRules, organizationId === 'org-a' ? [{ state: 'paused_failed' }] : [{ state: 'active' }]],
      ]))),
    )

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.autoRecharge).toEqual({ active: 1, pausedNeedsAuth: 0, pausedFailed: 1 })
  })

  it('counts an organization with a payment-blocked subscription as "blocked" in the recovery snapshot', async () => {
    mocks.listWorkerOrganizationIds.mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }])
    mocks.withWorkerOrganization.mockImplementation(async (organizationId: string, fn: (tx: unknown) => unknown) =>
      fn(tableAwareFakeTransaction(new Map([
        [billingSubscriptions, organizationId === 'org-a' ? [{ id: 'sub-1' }] : []],
      ]))),
    )

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.recovery.blocked).toBe(1)
  })

  it('detects a ledger invariant violation when the recomputed balance disagrees with remainingUnits', async () => {
    mocks.listWorkerOrganizationIds.mockResolvedValue([{ id: 'org-a' }])
    mocks.listActiveBillingCreditGrants.mockResolvedValue([{ id: 'grant-1', organizationId: 'org-a', remainingUnits: 100, originalUnits: 100, source: 'pack', state: 'active', expiresAt: new Date() }])
    mocks.withWorkerOrganization.mockImplementation(async (_organizationId: string, fn: (tx: unknown) => unknown) =>
      // computed 40 !== remainingUnits 100
      fn(tableAwareFakeTransaction(new Map([[billingLedgerEntries, [{ unitsDelta: 40 }]]]))),
    )

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.ledgerInvariant.violations).toBe(1)
  })

  it('reports country-gate rejections from the in-process counter, not fabricated', async () => {
    const metrics = await getBillingOperationsMetrics({ platform: db })
    expect(metrics.countryGate.rejectionsSinceStart).toBe(0)
  })
})

describe('getBillingOperationsMetrics — webhook age (real DB)', () => {
  it('computes the age in minutes of the oldest still-pending webhook event', async () => {
    // Clean slate: earlier tests in this file seeded their own (recent) pending rows, which would
    // otherwise win the MIN(receivedAt) comparison against this test's deliberately old row.
    await db.delete(billingWebhookEvents)
    const receivedAt = new Date(Date.now() - 90 * 60 * 1000) // 90 minutes ago
    await db.insert(billingWebhookEvents).values({
      id: uniqueId('evt'), livemode: false, stripeEventId: uniqueId('stripe'), apiVersion: '2024-01-01',
      objectType: 'checkout.session', eventType: 'checkout.session.completed', status: 'pending', payloadEncrypted: 'x', receivedAt,
    })

    const metrics = await getBillingOperationsMetrics({ platform: db })

    expect(metrics.webhookAge.oldestPendingMinutes).toBeGreaterThanOrEqual(89)
    expect(metrics.webhookAge.oldestPendingMinutes).toBeLessThanOrEqual(91)
  })

  it('reports null age when there is no pending webhook event', async () => {
    await db.delete(billingWebhookEvents)
    const metrics = await getBillingOperationsMetrics({ platform: db })
    expect(metrics.webhookAge.oldestPendingMinutes).toBeNull()
  })
})

describe('evaluateBillingAlerts', () => {
  it('returns no alerts for a fully clean metrics snapshot', () => {
    expect(evaluateBillingAlerts(CLEAN_METRICS_BASE)).toEqual([])
  })

  it('flags an oldest-pending-webhook age over the 120-minute SLO', () => {
    const alerts = evaluateBillingAlerts({ ...CLEAN_METRICS_BASE, webhookAge: { oldestPendingMinutes: 121 } })
    expect(alerts.some((a) => a.includes('121 minutes'))).toBe(true)
  })

  it('does not flag a webhook age exactly at the 120-minute SLO', () => {
    const alerts = evaluateBillingAlerts({ ...CLEAN_METRICS_BASE, webhookAge: { oldestPendingMinutes: 120 } })
    expect(alerts).toEqual([])
  })

  it('flags permanently failed webhook events', () => {
    const alerts = evaluateBillingAlerts({ ...CLEAN_METRICS_BASE, webhooks: { ...CLEAN_METRICS_BASE.webhooks, failed: 3 } })
    expect(alerts.some((a) => a.includes('3 webhook event'))).toBe(true)
  })

  it('flags a ledger invariant violation', () => {
    const alerts = evaluateBillingAlerts({ ...CLEAN_METRICS_BASE, ledgerInvariant: { violations: 1 } })
    expect(alerts.some((a) => a.includes('ledger invariant'))).toBe(true)
  })

  it('flags organizations with auto-recharge paused due to failure', () => {
    const alerts = evaluateBillingAlerts({ ...CLEAN_METRICS_BASE, autoRecharge: { active: 0, pausedNeedsAuth: 0, pausedFailed: 2 } })
    expect(alerts.some((a) => a.includes('auto-recharge paused'))).toBe(true)
  })

  it('flags a non-clean reconciliation run and never flags a clean one', () => {
    const dirty = evaluateBillingAlerts({ ...CLEAN_METRICS_BASE, reconciliation: { lastRun: { windowEnd: '2026-01-01T00:00:00.000Z', result: 'mismatches_found' } } })
    const clean = evaluateBillingAlerts({ ...CLEAN_METRICS_BASE, reconciliation: { lastRun: { windowEnd: '2026-01-01T00:00:00.000Z', result: 'clean' } } })
    expect(dirty.some((a) => a.includes('not clean'))).toBe(true)
    expect(clean).toEqual([])
  })
})
