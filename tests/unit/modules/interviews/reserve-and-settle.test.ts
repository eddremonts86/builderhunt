/**
 * Real disposable Postgres, real billing platform, fake provider.
 *
 * The billing side is *not* faked, deliberately. What is being tested is whether the wrapper obeys
 * the platform's contract — reservation states, idempotent replay, settlement against the actual
 * amount — and a fake ledger would let the wrapper be wrong in exactly the ways that matter while
 * every assertion passed.
 *
 * The provider is fake because the invariant under test is an *ordering* one: no provider request may
 * begin before a reservation exists. That is only observable by recording when the provider was
 * called relative to the reservation row, which a real provider cannot be asked to do.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { grantCredits } from '~/shared/lib/billing/credits'
import { FeatureBillingError } from '~/shared/lib/billing/feature-authorization'
import { authUsers, billingCreditReservations, billingCustomers, billingSubscriptions, organizations } from '~/shared/lib/db/schema'
import {
  InterviewBillingError,
  authorizeContextualQuestion,
  withInterviewCredits,
} from '~/modules/interviews/billing'
import { tenantTransaction } from '../../helpers/tenant-transaction'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

/**
 * A fresh organization per test.
 *
 * Credit grants accumulate, and sharing one organization made a later "there are no credits"
 * assertion quietly spend an earlier test's leftover balance — it passed by resolving successfully,
 * which is the opposite of what it claimed to prove.
 */
let ORG = ''
let principal = {} as never

async function freshOrganization(tier: 'pro' | 'none') {
  ORG = uniqueId('ib-org')
  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: ORG })
  principal = { organizationId: ORG, userId: USER, organizationRole: 'owner', requestId: uniqueId('req') } as never
  if (tier === 'pro') await seedSubscription('pro')
}

const USER = 'ib-user'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_reserve_settle')
  db = disposable.db
  drop = disposable.drop
  // `reserveCredits` records per-seat usage, which is FK'd to a real user.
  await db.insert(authUsers).values({
    id: USER, name: 'Owner', email: 'ib-user@test.invalid', emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  })
}, 120_000)

afterAll(async () => {
  await drop()
})

/**
 * A live paid subscription, without which every interview operation is refused on tier alone.
 * Same shape as `tests/unit/shared/lib/billing/feature-authorization.test.ts` seeds — the platform
 * reads `stripeStatus` and `tier`, and both need a customer row to hang off.
 */
async function seedSubscription(tier: 'pro' | 'free') {
  await db.delete(billingSubscriptions).where(eq(billingSubscriptions.organizationId, ORG))
  await db.delete(billingCustomers).where(eq(billingCustomers.organizationId, ORG))
  const customerId = uniqueId('customer')
  await db.insert(billingCustomers).values({
    id: customerId, organizationId: ORG, livemode: false,
    stripeCustomerId: `cus_${customerId}`, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(billingSubscriptions).values({
    id: uniqueId('sub'), organizationId: ORG, customerId, livemode: false,
    catalogKey: `${tier}_monthly`, tier, interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus: 'active', providerSyncedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(),
  })
}

async function seedCredits(units: number) {
  await tenantTransaction(db, ORG, (tx) => grantCredits(tx, {
    grantId: uniqueId('grant'),
    ledgerEntryId: uniqueId('entry'),
    organizationId: ORG,
    source: 'promotional',
    units,
    expiresAt: FAR_FUTURE(),
    idempotencyKey: uniqueId('idem'),
  }))
}

const readReservation = async (id: string) => {
  const [row] = await db.select().from(billingCreditReservations).where(eq(billingCreditReservations.id, id))
  return row
}

beforeEach(async () => {
  await freshOrganization('pro')
})

describe('no provider request starts before a reservation exists', () => {
  it('has a reserved row by the time the provider is called', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')
    let stateWhenProviderRan: string | null = null

    await tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'brief', reservationId, idempotencyKey: uniqueId('idem') },
      async () => {
        // Read from inside the provider callback. This is the assertion the whole wrapper exists for:
        // if the reservation were created after — or concurrently with — the provider call, this would
        // be null or 'pending'.
        const [row] = await tx.select().from(billingCreditReservations).where(eq(billingCreditReservations.id, reservationId))
        stateWhenProviderRan = row?.state ?? null
        return { result: 'brief text', actualUnits: 5, providerReference: 'provider-ref-1' }
      },
    ))

    expect(stateWhenProviderRan).toBe('reserved')
  })

  it('never calls the provider without a paid subscription', async () => {
    await freshOrganization('none')
    await seedCredits(100)
    let called = false

    await expect(tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'brief', reservationId: uniqueId('res'), idempotencyKey: uniqueId('idem') },
      async () => {
        called = true
        return { result: null, actualUnits: 0, providerReference: null }
      },
    ))).rejects.toMatchObject({ name: 'FeatureBillingError', code: 'insufficient_entitlement' })

    expect(called, 'a refused tier must cost nothing at the provider').toBe(false)
  })

  it('never calls the provider when there are no credits', async () => {
    let called = false

    await expect(tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'brief', reservationId: uniqueId('res'), idempotencyKey: uniqueId('idem') },
      async () => {
        called = true
        return { result: null, actualUnits: 0, providerReference: null }
      },
    ))).rejects.toBeInstanceOf(FeatureBillingError)

    expect(called).toBe(false)
  })
})

describe('settlement records what the provider actually billed', () => {
  it('settles below the reservation rather than at it', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')

    const outcome = await tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'report', reservationId, idempotencyKey: uniqueId('idem') },
      async () => ({ result: 'report', actualUnits: 2, providerReference: 'ref-2' }),
    ))

    expect(outcome.settledUnits).toBe(2)
    expect(outcome.providerReference).toBe('ref-2')
    const row = await readReservation(reservationId)
    expect(row.state).toBe('settled')
    // Reserved 5 (the card's maximum), consumed 2. Charging the reservation would over-bill every
    // operation that finished early.
    expect(row.maximumUnits).toBe(5)
    expect(row.settledUnits).toBe(2)
  })

  it('refuses to settle more than the reservation covered', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')

    await expect(tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'brief', reservationId, idempotencyKey: uniqueId('idem') },
      // 6 against a 5-unit card. The work should have extended first; failing here names that cause
      // rather than surfacing an opaque billing rejection.
      async () => ({ result: 'x', actualUnits: 6, providerReference: null }),
    ))).rejects.toMatchObject({ name: 'InterviewBillingError', code: 'settlement_exceeds_reservation' })
  })

  it('rejects a non-integer or negative actual', async () => {
    await seedCredits(100)
    for (const actualUnits of [-1, 1.5]) {
      await expect(tenantTransaction(db, ORG, (tx) => withInterviewCredits(
        tx as never,
        principal,
        { operation: 'brief', reservationId: uniqueId('res'), idempotencyKey: uniqueId('idem') },
        async () => ({ result: 'x', actualUnits, providerReference: null }),
      ))).rejects.toBeInstanceOf(InterviewBillingError)
    }
  })
})

describe('a failed provider does not leave a charge behind', () => {
  it('releases rather than settling, when the caller commits', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')

    // The error is caught *inside* the transaction, so it commits. This is the caller that the
    // release path exists for: a worker that fails one interview and keeps the rest of its
    // bookkeeping would otherwise leave a hold standing until the grace window expired.
    const caught = await tenantTransaction(db, ORG, async (tx) => {
      try {
        await withInterviewCredits(
          tx as never,
          principal,
          { operation: 'brief', reservationId, idempotencyKey: uniqueId('idem') },
          async () => { throw new Error('provider exploded') },
        )
        return null
      } catch (error) {
        return (error as Error).message
      }
    })

    expect(caught, 'the provider error propagates, not a bookkeeping one').toBe('provider exploded')
    const row = await readReservation(reservationId)
    // Released, not settled-at-zero: reconciliation must be able to tell "nothing happened" from
    // "happened and cost nothing".
    expect(row.state).toBe('released')
  })

  it('leaves nothing at all when the caller lets the error roll its transaction back', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')

    await expect(tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'brief', reservationId, idempotencyKey: uniqueId('idem') },
      async () => { throw new Error('provider exploded') },
    ))).rejects.toThrow('provider exploded')

    // No row, not a released one — the reservation was created inside the transaction that just
    // rolled back. Equally correct, and worth pinning: which of the two happens is the caller's
    // choice of transaction boundary, not something the wrapper decides.
    expect(await readReservation(reservationId)).toBeUndefined()
  })
})

describe('long-running work extends its own budget', () => {
  it('raises the ceiling and settles against the extended amount', async () => {
    await seedCredits(400)
    const reservationId = uniqueId('res')

    const outcome = await tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'transcriptionPerMinute', reservationId, idempotencyKey: uniqueId('idem') },
      async (context) => {
        expect(context.maximumUnits).toBe(180)
        const raised = await context.extend(30)
        expect(raised).toBe(210)
        expect(context.maximumUnits, 'the context reflects the new ceiling').toBe(210)
        return { result: 'transcript', actualUnits: 200, providerReference: 'deepgram-1' }
      },
    ))

    expect(outcome.settledUnits).toBe(200)
    expect((await readReservation(reservationId)).maximumUnits).toBe(210)
  })

  it('surfaces a refused extension so the caller can stop', async () => {
    // Only enough for the initial hold. spec.md: paid provider capture stops at zero — and the
    // wrapper's contract is that a refused extension throws rather than returning a falsy value a
    // caller might ignore and keep spending against.
    await seedCredits(180)
    const reservationId = uniqueId('res')

    await expect(tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'transcriptionPerMinute', reservationId, idempotencyKey: uniqueId('idem') },
      async (context) => {
        await context.extend(60)
        return { result: 'never reached', actualUnits: 1, providerReference: null }
      },
    ))).rejects.toMatchObject({ code: 'insufficient_credits' })

    // Rolled back with the caller's transaction, as above. What matters for the contract is that the
    // refusal *threw* — a caller cannot mistake it for a granted extension and keep spending.
    expect(await readReservation(reservationId)).toBeUndefined()
  })

  it('rejects a non-positive extension', async () => {
    await seedCredits(400)
    await expect(tenantTransaction(db, ORG, (tx) => withInterviewCredits(
      tx as never,
      principal,
      { operation: 'transcriptionPerMinute', reservationId: uniqueId('res'), idempotencyKey: uniqueId('idem') },
      async (context) => {
        await context.extend(0)
        return { result: 'x', actualUnits: 1, providerReference: null }
      },
    ))).rejects.toBeInstanceOf(InterviewBillingError)
  })
})

describe('contextual questions are gated by two conditions, not one', () => {
  it('allows a paid tier with a live transcription', async () => {
    await expect(tenantTransaction(db, ORG, (tx) =>
      authorizeContextualQuestion(tx as never, principal, { transcriptionReservationActive: true })))
      .resolves.toBeUndefined()
  })

  it('refuses a paid tier with no live transcription', async () => {
    // The check that stops the question endpoint being used as a free general-purpose model between
    // interviews. Tier alone would allow it.
    await expect(tenantTransaction(db, ORG, (tx) =>
      authorizeContextualQuestion(tx as never, principal, { transcriptionReservationActive: false })))
      .rejects.toMatchObject({ name: 'InterviewBillingError', code: 'transcription_not_active' })
  })

  it('refuses an unsubscribed organization even with a live transcription', async () => {
    await freshOrganization('none')
    await expect(tenantTransaction(db, ORG, (tx) =>
      authorizeContextualQuestion(tx as never, principal, { transcriptionReservationActive: true })))
      .rejects.toMatchObject({ code: 'insufficient_entitlement' })
  })

  it('reserves nothing', async () => {
    const before = await db.select().from(billingCreditReservations)
    await tenantTransaction(db, ORG, (tx) =>
      authorizeContextualQuestion(tx as never, principal, { transcriptionReservationActive: true }))
    const after = await db.select().from(billingCreditReservations)
    expect(after.length, 'included means included — no hold, no ledger entry').toBe(before.length)
  })
})
