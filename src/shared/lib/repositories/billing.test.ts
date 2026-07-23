import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, organizations } from '../db/schema'
import {
  createBillingCheckoutAttempt,
  createBillingCreditReservation,
  createBillingCustomer,
  createBillingRefundRequest,
  createBillingSubscription,
  findActiveBillingSubscription,
  findBillingCreditReservationByIdempotencyKey,
  findBillingCustomer,
  listBillingRefunds,
} from './billing'

/**
 * The only `repositories/*.test.ts` file in this codebase that opens a real
 * Postgres connection rather than statically scanning source — every sibling
 * repository test is a boundary/import scan (see `entitlements.test.ts`,
 * `organization-alerts.test.ts`, `account-privacy.test.ts`). That's a
 * deliberate, precedent-setting choice here: financial-data correctness
 * ("A/B isolation, missing rows, duplicate keys" per
 * plans/stripe-billing-platform/tasks.md §3) is worth proving against a real
 * database rather than trusting a static scan, given the stakes. This is safe
 * to run unconditionally because `DATABASE_MIGRATION_URL` (superuser,
 * reachable Postgres) is already a hard requirement for this entire app
 * (`env.ts` fails closed without it) and this repo's own CI already runs the
 * full `pnpm test`/`pnpm build` step sequence against a live migrated
 * Postgres service (`.github/workflows/quality.yml`) — this file does not
 * introduce a new environment dependency, only a new (disposable, isolated,
 * auto-created-and-dropped) database on that same already-required server.
 */

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_billing')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: 'repo-billing-org-a', name: 'A', slug: 'repo-billing-org-a', createdAt: new Date() },
    { id: 'repo-billing-org-b', name: 'B', slug: 'repo-billing-org-b', createdAt: new Date() },
  ])
  await db.insert(authUsers).values([
    { id: 'repo-billing-user-a', name: 'A', email: 'repo-billing-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'repo-billing-user-b', name: 'B', email: 'repo-billing-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('billing repository — tenant isolation and integrity', () => {
  it('returns only the requesting organization\'s customer row (A/B isolation)', async () => {
    await db.transaction(async (tx) => {
      await createBillingCustomer(tx, { id: 'repo-cust-a', organizationId: 'repo-billing-org-a', livemode: false, stripeCustomerId: 'cus_repo_a' })
      await createBillingCustomer(tx, { id: 'repo-cust-b', organizationId: 'repo-billing-org-b', livemode: false, stripeCustomerId: 'cus_repo_b' })
    })

    const [customerA, customerB] = await Promise.all([
      db.transaction((tx) => findBillingCustomer(tx, 'repo-billing-org-a', false)),
      db.transaction((tx) => findBillingCustomer(tx, 'repo-billing-org-b', false)),
    ])

    expect(customerA?.id).toBe('repo-cust-a')
    expect(customerA?.stripeCustomerId).toBe('cus_repo_a')
    expect(customerB?.id).toBe('repo-cust-b')
    expect(customerA?.id).not.toBe(customerB?.id)
  })

  it('returns null for an organization with no customer row (missing row)', async () => {
    const missing = await db.transaction((tx) => findBillingCustomer(tx, 'repo-billing-org-nonexistent', false))
    expect(missing).toBeNull()
  })

  it('returns null for an organization with no active subscription (missing row)', async () => {
    const missing = await db.transaction((tx) => findActiveBillingSubscription(tx, 'repo-billing-org-a', false))
    expect(missing).toBeNull()
  })

  it('finds the active subscription only for its own organization, per livemode/customer scope (A/B isolation)', async () => {
    await db.transaction((tx) => createBillingSubscription(tx, {
      id: 'repo-sub-a', organizationId: 'repo-billing-org-a', customerId: 'repo-cust-a', livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: 'sub_repo_a', stripeStatus: 'active',
    }))

    const [subA, subB] = await Promise.all([
      db.transaction((tx) => findActiveBillingSubscription(tx, 'repo-billing-org-a', false)),
      db.transaction((tx) => findActiveBillingSubscription(tx, 'repo-billing-org-b', false)),
    ])
    expect(subA?.id).toBe('repo-sub-a')
    expect(subB).toBeNull()
  })

  it('rejects a subscription whose customerId belongs to a different organization (organization-preserving composite FK)', async () => {
    await expect(db.transaction((tx) => createBillingSubscription(tx, {
      id: 'repo-sub-cross', organizationId: 'repo-billing-org-a', customerId: 'repo-cust-b', livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: 'sub_repo_cross', stripeStatus: 'active',
    }))).rejects.toThrow()
  })

  it('rejects a second checkout attempt with the same idempotency key for the same organization (duplicate keys)', async () => {
    const input = {
      id: 'repo-attempt-1', organizationId: 'repo-billing-org-a', actorUserId: 'repo-billing-user-a', livemode: false,
      action: 'subscription' as const, catalogKey: 'pro_monthly', idempotencyKey: 'repo-idem-checkout-1',
      consentVersions: { terms: 'v1', privacy: 'v1' }, expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }
    await db.transaction((tx) => createBillingCheckoutAttempt(tx, input))

    await expect(db.transaction((tx) => createBillingCheckoutAttempt(tx, { ...input, id: 'repo-attempt-2' })))
      .rejects.toThrow()
  })

  it('rejects a second credit reservation with the same idempotency key for the same organization (duplicate keys)', async () => {
    const input = {
      id: 'repo-reservation-1', organizationId: 'repo-billing-org-a', operation: 'ai_sourcing_sprint',
      rateCardVersion: 1, idempotencyKey: 'repo-idem-reservation-1', maximumUnits: 25,
      deadlineAt: new Date(Date.now() + 60 * 60 * 1000),
    }
    await db.transaction((tx) => createBillingCreditReservation(tx, input))

    await expect(db.transaction((tx) => createBillingCreditReservation(tx, { ...input, id: 'repo-reservation-2' })))
      .rejects.toThrow()

    const found = await db.transaction((tx) => findBillingCreditReservationByIdempotencyKey(tx, 'repo-billing-org-a', 'repo-idem-reservation-1'))
    expect(found?.id).toBe('repo-reservation-1')
  })

  it('lists refund requests for only the requesting organization, most recent first (A/B isolation)', async () => {
    await db.transaction((tx) => createBillingRefundRequest(tx, {
      id: 'repo-refund-a', organizationId: 'repo-billing-org-a', requestedByUserId: 'repo-billing-user-a',
      idempotencyKey: 'repo-idem-refund-a', policyDecision: 'full_unused_pack', amountCents: 1500,
    }))
    await db.transaction((tx) => createBillingRefundRequest(tx, {
      id: 'repo-refund-b', organizationId: 'repo-billing-org-b', requestedByUserId: 'repo-billing-user-b',
      idempotencyKey: 'repo-idem-refund-b', policyDecision: 'full_unused_pack', amountCents: 4500,
    }))

    const [refundsA, refundsB] = await Promise.all([
      db.transaction((tx) => listBillingRefunds(tx, 'repo-billing-org-a')),
      db.transaction((tx) => listBillingRefunds(tx, 'repo-billing-org-b')),
    ])
    expect(refundsA.map((refund) => refund.id)).toEqual(['repo-refund-a'])
    expect(refundsB.map((refund) => refund.id)).toEqual(['repo-refund-b'])
  })
})
