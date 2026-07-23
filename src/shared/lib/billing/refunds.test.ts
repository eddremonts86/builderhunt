import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingCreditGrants, billingRefunds, organizations } from '../db/schema'
import { PACK_CATALOG } from './catalog'
import { FakeBillingProvider } from './fake-provider'
import {
  decideRefund,
  processPendingPackRefund,
  RefundError,
  requestPackRefund,
} from './refunds'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `refunds-${label}-${counter}`
}

async function freshOrg(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  return { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

const OPERATOR = { userId: 'refund-operator-1', requestId: 'req-1' }

/** Seeds a pack grant AND a matching fake PaymentIntent so `provider.createRefund` can find it — mirrors what `handlePackCheckoutCompleted` would have done at purchase time. */
async function seedRefundablePackGrant(
  provider: FakeBillingProvider,
  organizationId: string,
  packKey: keyof typeof PACK_CATALOG,
  overrides: Partial<{ remainingUnits: number; state: string }> = {},
): Promise<{ grantId: string; paymentIntentId: string }> {
  const catalogEntry = PACK_CATALOG[packKey]
  const paymentIntent = await provider.createPaymentIntent({
    customerId: uniqueId('cus'),
    amount: catalogEntry.amountCents,
    currency: 'usd',
    idempotencyKey: uniqueId('pi-idem'),
  })
  const grantId = uniqueId('grant')
  await db.insert(billingCreditGrants).values({
    id: grantId,
    organizationId,
    source: 'pack',
    sourceReference: packKey,
    stripePaymentReference: uniqueId('cs'),
    stripePaymentIntentId: paymentIntent.id,
    originalUnits: catalogEntry.credits,
    remainingUnits: overrides.remainingUnits ?? catalogEntry.credits,
    state: overrides.state ?? 'active',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  })
  return { grantId, paymentIntentId: paymentIntent.id }
}

async function readGrant(grantId: string) {
  const [row] = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.id, grantId))
  return row
}

/**
 * Directly seeds a pending refund row for an ALREADY-partially-used pack grant — this bypasses
 * `requestPackRefund`'s own validation, standing in for the not-yet-built operator-initiated
 * creation path (see `refunds.ts`'s module comment: a partial pack refund is never self-service,
 * so there is no owner-facing route that could ever produce this row; an operator would create it
 * through a support-ops path this pass doesn't build). Only used to test `decideRefund`/
 * `processPendingPackRefund`'s own behavior once such a row already exists.
 */
async function seedPendingRefundRow(organizationId: string, requestedByUserId: string, grantId: string, amountCents: number) {
  const id = uniqueId('refund')
  await db.insert(billingRefunds).values({
    id, organizationId, requestedByUserId, grantId,
    idempotencyKey: uniqueId('idem'), policyDecision: 'full_unused_pack', amountCents,
  })
  return id
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('refunds')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: OPERATOR.userId, name: 'Operator', email: 'refund-operator@test.invalid',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
})

afterAll(async () => {
  await drop()
})

describe('requestPackRefund', () => {
  let provider: FakeBillingProvider

  beforeEach(() => {
    provider = new FakeBillingProvider()
  })

  it('creates a pending full_unused_pack request for a fully unused pack', async () => {
    const principal = await freshOrg()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300')

    const refund = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') }))

    expect(refund.policyDecision).toBe('full_unused_pack')
    expect(refund.state).toBe('pending')
    expect(refund.amountCents).toBe(PACK_CATALOG.starter_300.amountCents)
    expect(refund.stripeRefundId).toBeNull()
  })

  it('rejects a partially-used pack — no self-service', async () => {
    const principal = await freshOrg()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300', { remainingUnits: PACK_CATALOG.starter_300.credits - 1 })

    await expect(db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') })))
      .rejects.toMatchObject({ code: 'partially_used' })
  })

  it('rejects a grant that is not a pack', async () => {
    const principal = await freshOrg()
    const grantId = uniqueId('grant')
    await db.insert(billingCreditGrants).values({
      id: grantId, organizationId: principal.organizationId, source: 'subscription_monthly',
      originalUnits: 100, remainingUnits: 100, expiresAt: new Date('2099-01-01T00:00:00Z'),
    })

    await expect(db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') })))
      .rejects.toMatchObject({ code: 'not_a_pack_grant' })
  })

  it('rejects a grant that is not active (already revoked)', async () => {
    const principal = await freshOrg()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300', { state: 'revoked' })

    await expect(db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') })))
      .rejects.toMatchObject({ code: 'not_active' })
  })

  it('rejects an unknown grant', async () => {
    const principal = await freshOrg()
    await expect(db.transaction((tx) => requestPackRefund(tx, principal, { grantId: 'nonexistent', idempotencyKey: uniqueId('idem') })))
      .rejects.toMatchObject({ code: 'grant_not_found' })
  })

  it('a duplicate request (same idempotency key) replays the original row instead of re-validating', async () => {
    const principal = await freshOrg()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300')
    const idempotencyKey = uniqueId('idem')

    const first = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey }))
    const second = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey }))

    expect(second.id).toBe(first.id)
  })
})

describe('decideRefund', () => {
  it('records the operator decision on a pending request', async () => {
    const principal = await freshOrg()
    const provider = new FakeBillingProvider()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'scale_1000', { remainingUnits: 500 })
    const refundId = await seedPendingRefundRow(principal.organizationId, principal.userId, grantId, 4500)

    const decided = await db.transaction((tx) => decideRefund(tx, OPERATOR, principal.organizationId, {
      refundId,
      policyDecision: 'partial_pack_operator',
      amountCents: 2250,
      creditRevocationUnits: 500,
    }))

    expect(decided.policyDecision).toBe('partial_pack_operator')
    expect(decided.amountCents).toBe(2250)
    expect(decided.creditRevocationUnits).toBe(500)
    expect(decided.operatorUserId).toBe(OPERATOR.userId)
  })

  it('rejects deciding a refund that does not exist', async () => {
    const principal = await freshOrg()
    await expect(db.transaction((tx) => decideRefund(tx, OPERATOR, principal.organizationId, {
      refundId: 'nonexistent', policyDecision: 'partial_pack_operator', amountCents: 100,
    }))).rejects.toBeInstanceOf(RefundError)
  })

  it('rejects deciding a refund that already has a provider refund sent', async () => {
    const principal = await freshOrg()
    const provider = new FakeBillingProvider()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300')
    const refund = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') }))
    await db.transaction((tx) => processPendingPackRefund(tx, principal.organizationId, refund.id, { provider }))

    await expect(db.transaction((tx) => decideRefund(tx, OPERATOR, principal.organizationId, {
      refundId: refund.id, policyDecision: 'partial_pack_operator', amountCents: 100,
    }))).rejects.toMatchObject({ code: 'decision_conflict' })
  })
})

describe('processPendingPackRefund', () => {
  it('sends a full refund to the provider and fully revokes the grant on success', async () => {
    const principal = await freshOrg()
    const provider = new FakeBillingProvider()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300')
    const refund = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') }))

    const outcome = await db.transaction((tx) => processPendingPackRefund(tx, principal.organizationId, refund.id, { provider }))

    expect(outcome.processed).toBe(true)
    const grant = await readGrant(grantId)
    expect(grant.state).toBe('revoked')
    expect(grant.remainingUnits).toBe(0)
  })

  it('sends a partial refund and revokes only the operator-approved units, preserving consumed history', async () => {
    const principal = await freshOrg()
    const provider = new FakeBillingProvider()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'scale_1000', { remainingUnits: 500 })
    const refundId = await seedPendingRefundRow(principal.organizationId, principal.userId, grantId, 4500)
    await db.transaction((tx) => decideRefund(tx, OPERATOR, principal.organizationId, {
      refundId, policyDecision: 'partial_pack_operator', amountCents: 2250, creditRevocationUnits: 300,
    }))

    const outcome = await db.transaction((tx) => processPendingPackRefund(tx, principal.organizationId, refundId, { provider }))

    expect(outcome.processed).toBe(true)
    const grant = await readGrant(grantId)
    expect(grant.state).toBe('active')
    expect(grant.remainingUnits).toBe(200) // 500 - 300, never touching the already-consumed 500
  })

  it('is idempotent — processing an already-processed refund is a safe no-op', async () => {
    const principal = await freshOrg()
    const provider = new FakeBillingProvider()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300')
    const refund = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') }))

    const first = await db.transaction((tx) => processPendingPackRefund(tx, principal.organizationId, refund.id, { provider }))
    const second = await db.transaction((tx) => processPendingPackRefund(tx, principal.organizationId, refund.id, { provider }))

    expect(first.processed).toBe(true)
    expect(second).toEqual({ processed: false, reason: 'not eligible for processing' })
  })

  it('marks repair_needed when the linked grant has no PaymentIntent to refund against', async () => {
    const principal = await freshOrg()
    const provider = new FakeBillingProvider()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300')
    const refund = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') }))
    // Simulates a grant that predates PaymentIntent capture (or was otherwise malformed) — the FK
    // from billing_refunds.grant_id prevents actually deleting the grant row out from under a
    // refund, so the realistic "unrefundable grant" case is a missing stripePaymentIntentId, not a
    // vanished row.
    await db.update(billingCreditGrants).set({ stripePaymentIntentId: null }).where(eq(billingCreditGrants.id, grantId))

    const outcome = await db.transaction((tx) => processPendingPackRefund(tx, principal.organizationId, refund.id, { provider }))

    expect(outcome).toEqual({ processed: false, reason: 'linked grant is missing or has no PaymentIntent to refund' })
    const { findFullBillingRefund } = await import('../repositories/billing')
    const row = await db.transaction((tx) => findFullBillingRefund(tx, principal.organizationId, refund.id))
    expect(row?.state).toBe('repair_needed')
  })

  it('marks failed when the provider declines the refund', async () => {
    const principal = await freshOrg()
    class DeclineProvider extends FakeBillingProvider {
      override async createRefund(): Promise<never> {
        throw new Error('Refund declined by provider')
      }
    }
    const provider = new DeclineProvider()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300')
    const refund = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') }))

    const outcome = await db.transaction((tx) => processPendingPackRefund(tx, principal.organizationId, refund.id, { provider }))

    expect(outcome.processed).toBe(false)
    const { findFullBillingRefund } = await import('../repositories/billing')
    const row = await db.transaction((tx) => findFullBillingRefund(tx, principal.organizationId, refund.id))
    expect(row?.state).toBe('failed')
    const grant = await readGrant(grantId)
    expect(grant.state).toBe('active') // never revoked on a failed refund
  })

  it('never processes a subscription refund decision — leaves it pending', async () => {
    const principal = await freshOrg()
    const provider = new FakeBillingProvider()
    const { grantId } = await seedRefundablePackGrant(provider, principal.organizationId, 'starter_300')
    const refund = await db.transaction((tx) => requestPackRefund(tx, principal, { grantId, idempotencyKey: uniqueId('idem') }))
    await db.transaction((tx) => decideRefund(tx, OPERATOR, principal.organizationId, {
      refundId: refund.id, policyDecision: 'full_subscription_invoice', amountCents: 1900,
    }))

    const outcome = await db.transaction((tx) => processPendingPackRefund(tx, principal.organizationId, refund.id, { provider }))

    expect(outcome).toEqual({ processed: false, reason: 'not a pack refund — subscription refund processing is not built yet' })
  })
})
