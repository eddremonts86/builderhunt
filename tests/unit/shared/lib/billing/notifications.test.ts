import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers,
  billingCreditGrants,
  billingCustomers,
  billingDisputes,
  billingNotificationLog,
  billingReconciliationRuns,
  billingRefunds,
  billingSellerProfiles,
  billingSubscriptions,
  organizationMembers,
  organizations,
} from '~/shared/lib/db/schema'

const emailMocks = vi.hoisted(() => ({
  sendCreditExpiryNoticeEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendSubscriptionRenewalReminderEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendActionRequiredEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendBillingPaymentFailedEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendRefundDecisionEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendDisputeNotificationEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendReconciliationAlertEmail: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('~/shared/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/email')>()
  return { ...actual, ...emailMocks }
})

const { recordNotificationIfDue, runNotificationSweep } = await import('~/shared/lib/billing/notifications')

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `notif-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('billing_notifications')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

beforeEach(() => {
  for (const mock of Object.values(emailMocks)) mock.mockClear()
})

async function freshOrg(): Promise<string> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizationMembers).values({ id: uniqueId('member'), organizationId: orgId, userId, role: 'owner', createdAt: new Date() })
  return orgId
}

function deps(now: Date, overrides: Record<string, unknown> = {}) {
  return { worker: db, platform: db, now: () => now, ...overrides }
}

describe('recordNotificationIfDue', () => {
  it('returns true only the first time a given (organization, type, window) triple is recorded', async () => {
    const orgId = uniqueId('org')
    const first = await recordNotificationIfDue(db, { organizationId: orgId, notificationType: 'refund_decision', windowKey: 'refund-1' })
    const second = await recordNotificationIfDue(db, { organizationId: orgId, notificationType: 'refund_decision', windowKey: 'refund-1' })

    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  it('returns true again for a different window key — a new policy window is genuinely new', async () => {
    const orgId = uniqueId('org')
    const first = await recordNotificationIfDue(db, { organizationId: orgId, notificationType: 'refund_decision', windowKey: 'refund-1' })
    const second = await recordNotificationIfDue(db, { organizationId: orgId, notificationType: 'refund_decision', windowKey: 'refund-2' })

    expect(first).toBe(true)
    expect(second).toBe(true)
  })
})

describe('runNotificationSweep — credit expiry 30/7/1', () => {
  it('sends a T-30 notice for a grant expiring in exactly 30 days, and nothing for one expiring in 29 or 31', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-01-01T00:00:00Z')
    await db.insert(billingCreditGrants).values({
      id: uniqueId('grant'), organizationId: orgId, source: 'pack', originalUnits: 300, remainingUnits: 300,
      expiresAt: new Date('2031-01-31T00:00:00Z'), // exactly 30 days out
    })
    await db.insert(billingCreditGrants).values({
      id: uniqueId('grant'), organizationId: orgId, source: 'pack', originalUnits: 300, remainingUnits: 300,
      expiresAt: new Date('2031-02-05T00:00:00Z'), // 35 days out — no bucket match
    })

    const result = await runNotificationSweep(deps(now))

    expect(result.sent.credit_expiry_30).toBe(1)
    expect(emailMocks.sendCreditExpiryNoticeEmail).toHaveBeenCalledTimes(1)
  })

  it('sends only one T-7 notice even if the sweep runs twice for the same grant', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-02-01T00:00:00Z')
    await db.insert(billingCreditGrants).values({
      id: uniqueId('grant'), organizationId: orgId, source: 'pack', originalUnits: 300, remainingUnits: 300,
      expiresAt: new Date('2031-02-08T00:00:00Z'), // exactly 7 days out
    })

    const first = await runNotificationSweep(deps(now))
    const second = await runNotificationSweep(deps(now))

    expect(first.sent.credit_expiry_7).toBe(1)
    expect(second.sent.credit_expiry_7).toBe(0)
    expect(emailMocks.sendCreditExpiryNoticeEmail).toHaveBeenCalledTimes(1)
  })

  it('sends a T-1 notice for a grant expiring tomorrow', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-03-01T00:00:00Z')
    await db.insert(billingCreditGrants).values({
      id: uniqueId('grant'), organizationId: orgId, source: 'pack', originalUnits: 300, remainingUnits: 300,
      expiresAt: new Date('2031-03-02T00:00:00Z'),
    })

    const result = await runNotificationSweep(deps(now))

    expect(result.sent.credit_expiry_1).toBe(1)
  })
})

describe('runNotificationSweep — subscription renewal, grace, and action-required', () => {
  async function seedSubscription(organizationId: string, overrides: Partial<{ currentPeriodEnd: Date; gracePeriodEndsAt: Date | null; paymentBlockedAt: Date | null; cancelAtPeriodEnd: boolean }> = {}) {
    const customerId = uniqueId('cust-row')
    await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
    const subscriptionId = uniqueId('sub-row')
    await db.insert(billingSubscriptions).values({
      id: subscriptionId, organizationId, customerId, livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus: 'active',
      currentPeriodEnd: overrides.currentPeriodEnd ?? new Date('2032-01-01T00:00:00Z'),
      cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
      gracePeriodEndsAt: overrides.gracePeriodEndsAt ?? null,
      paymentBlockedAt: overrides.paymentBlockedAt ?? null,
    })
    return subscriptionId
  }

  it('sends a renewal reminder exactly 7 days before currentPeriodEnd', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-04-01T00:00:00Z')
    await seedSubscription(orgId, { currentPeriodEnd: new Date('2031-04-08T00:00:00Z') })

    const result = await runNotificationSweep(deps(now))

    expect(result.sent.subscription_renewal).toBe(1)
  })

  it('does not send a renewal reminder for a subscription already set to cancel at period end', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-05-01T00:00:00Z')
    await seedSubscription(orgId, { currentPeriodEnd: new Date('2031-05-08T00:00:00Z'), cancelAtPeriodEnd: true })

    const result = await runNotificationSweep(deps(now))

    expect(result.sent.subscription_renewal).toBe(0)
  })

  it('sends exactly one grace-period notice per grace instance, deduped by gracePeriodEndsAt', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-06-01T00:00:00Z')
    await seedSubscription(orgId, { gracePeriodEndsAt: new Date('2031-06-10T00:00:00Z') })

    const first = await runNotificationSweep(deps(now))
    const second = await runNotificationSweep(deps(now))

    expect(first.sent.grace_period).toBe(1)
    expect(second.sent.grace_period).toBe(0)
    expect(emailMocks.sendBillingPaymentFailedEmail).toHaveBeenCalledTimes(1)
  })

  it('sends an action-required notice when payment is blocked', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-07-01T00:00:00Z')
    await seedSubscription(orgId, { paymentBlockedAt: new Date('2031-06-28T00:00:00Z') })

    const result = await runNotificationSweep(deps(now))

    expect(result.sent.action_required).toBe(1)
    expect(emailMocks.sendActionRequiredEmail).toHaveBeenCalledTimes(1)
  })
})

describe('runNotificationSweep — refunds and disputes', () => {
  it('sends one refund-decision notice per decided refund, never for a still-pending one', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-08-01T00:00:00Z')
    const requesterId = uniqueId('requester')
    await db.insert(authUsers).values({ id: requesterId, name: requesterId, email: `${requesterId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    await db.insert(billingRefunds).values({
      id: uniqueId('refund'), organizationId: orgId, requestedByUserId: requesterId, idempotencyKey: uniqueId('idem'),
      policyDecision: 'full_unused_pack', amountCents: 500, state: 'succeeded',
    })
    await db.insert(billingRefunds).values({
      id: uniqueId('refund'), organizationId: orgId, requestedByUserId: requesterId, idempotencyKey: uniqueId('idem'),
      policyDecision: 'full_unused_pack', amountCents: 999, state: 'pending',
    })

    const result = await runNotificationSweep(deps(now))

    expect(result.sent.refund_decision).toBe(1)
    expect(emailMocks.sendRefundDecisionEmail).toHaveBeenCalledTimes(1)
  })

  it('sends one dispute-opened notice per dispute, and never a second one for the same dispute', async () => {
    const orgId = await freshOrg()
    const now = new Date('2031-09-01T00:00:00Z')
    const grantId = uniqueId('grant')
    await db.insert(billingCreditGrants).values({
      id: grantId, organizationId: orgId, source: 'pack', originalUnits: 300, remainingUnits: 0,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    })
    await db.insert(billingDisputes).values({
      id: uniqueId('dispute'), organizationId: orgId, grantId, stripeDisputeId: uniqueId('dp'),
      stripePaymentIntentId: uniqueId('pi'), amountCents: 1500, stripeStatus: 'warning_needs_response',
    })

    const first = await runNotificationSweep(deps(now))
    const second = await runNotificationSweep(deps(now))

    expect(first.sent.dispute_opened).toBe(1)
    expect(second.sent.dispute_opened).toBe(0)
  })
})

describe('runNotificationSweep — reconciliation mismatch (platform-wide)', () => {
  it('alerts the current seller profile support email once per non-clean run, never for a clean one', async () => {
    const now = new Date('2031-10-01T00:00:00Z')
    const adminUserId = uniqueId('admin')
    await db.insert(authUsers).values({ id: adminUserId, name: adminUserId, email: `${adminUserId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    await db.insert(billingSellerProfiles).values({
      id: randomUUID(), version: 1, legalName: 'Acme ApS', publicBusinessAddress: 'Somewhere 1',
      establishmentCountry: 'DK', approvedTaxIds: [], supportEmail: 'support@test.invalid', statementDescriptor: 'ACME',
      countryAllowlist: ['DK'], taxRegistrations: [], effectiveAt: new Date('2026-01-01T00:00:00Z'), createdByUserId: adminUserId,
    })
    const runId = uniqueId('run')
    await db.insert(billingReconciliationRuns).values({
      id: runId, windowStart: new Date('2031-09-30T00:00:00Z'), windowEnd: new Date('2031-10-01T00:00:00Z'),
      countsChecked: {}, mismatches: [{ type: 'missing_internal', reference: 'x', detail: 'y' }], repairs: [], result: 'mismatches_found',
    })

    const first = await runNotificationSweep(deps(now))
    const second = await runNotificationSweep(deps(now))

    expect(first.sent.reconciliation_mismatch).toBe(1)
    expect(second.sent.reconciliation_mismatch).toBe(0)
    expect(emailMocks.sendReconciliationAlertEmail).toHaveBeenCalledWith('support@test.invalid', expect.objectContaining({ result: 'mismatches_found' }))

    const [row] = await db.select().from(billingNotificationLog).where(eq(billingNotificationLog.windowKey, runId))
    expect(row.organizationId).toBe('platform')
  })

  it('never alerts for a clean run', async () => {
    const now = new Date('2031-11-01T00:00:00Z')
    await db.insert(billingReconciliationRuns).values({
      id: uniqueId('run'), windowStart: new Date('2031-10-31T00:00:00Z'), windowEnd: new Date('2031-11-01T00:00:00Z'),
      countsChecked: {}, mismatches: [], repairs: [], result: 'clean',
    })

    const result = await runNotificationSweep(deps(now))

    expect(result.sent.reconciliation_mismatch).toBe(0)
  })
})
