/**
 * The Solutions credit boundary, against a real disposable Postgres and the real billing platform.
 *
 * The billing side is deliberately not faked, for the same reason `interviews/reserve-and-settle.test.ts`
 * does not fake it: what is under test is whether this wrapper obeys the platform's contract — reservation
 * states, idempotent replay, settlement amounts — and a fake ledger would let the wrapper be wrong in exactly
 * the ways that matter while every assertion passed.
 *
 * The provider is fake because the invariants are about *ordering* and *outcome classification*: no provider
 * request may begin before a reservation exists, and a usable result settles the fixed price while an unusable
 * one releases. Neither is observable through a real provider.
 *
 * The plan's verify line names the cases: Free, suspended, insufficient credits, owner/member actions,
 * concurrent duplicate, timeout before and after the provider, usable partial, unusable partial, and
 * reconciliation.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { grantCredits } from '~/shared/lib/billing/credits'
import { FeatureBillingError } from '~/shared/lib/billing/feature-authorization'
import { authUsers, billingCreditReservations, billingCustomers, billingSubscriptions, organizations } from '~/shared/lib/db/schema'
import { RATE_CARDS } from '~/shared/lib/billing/rate-cards'
import { tenantTransaction } from '../../helpers/tenant-transaction'

/**
 * The paid path is flag-gated and every flag defaults off, so a test of the paid boundary has to turn it on.
 *
 * Mocked rather than set through `env`: `env` is parsed once at module load, so a `stubEnv` after that point
 * changes nothing. `vi.importActual` is not an option either — it bypasses the mock only for the module asked
 * for, while that module's own imports still resolve through the registry, so an "actual" billing module would
 * have kept the mocked config. A mutable holder is what lets one file test both sides of the flag.
 */
const flagState = vi.hoisted(() => ({ paidGenerationEnabled: true }))
vi.mock('~/shared/lib/solutions/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/solutions/config')>()
  return {
    ...actual,
    getSolutionsFeatureFlags: () => ({
      ...actual.getSolutionsFeatureFlags(),
      paidGenerationEnabled: flagState.paidGenerationEnabled,
    }),
  }
})

const { SolutionsBillingError, describeSolutionsCharge, withSolutionsCredits } = await import('~/modules/solutions/server/billing')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)
let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

const GENERATE_PRICE = RATE_CARDS.solutions_generate.maxUnits
const REGENERATE_PRICE = RATE_CARDS.solutions_regenerate.maxUnits
/** What a client would have displayed and the user agreed to. */
const CONFIRMED = { acceptedUnits: GENERATE_PRICE, acceptedRateCardVersion: RATE_CARDS.solutions_generate.version }

const USER = 'sb-user'
const MEMBER = 'sb-member'
let ORG = ''
let principal = {} as never

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('solutions_billing')
  db = disposable.db
  drop = disposable.drop
  // `reserveCredits` records per-seat usage, FK'd to a real user.
  await db.insert(authUsers).values([
    { id: USER, name: 'Owner', email: 'sb-user@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: MEMBER, name: 'Member', email: 'sb-member@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
}, 180_000)

afterAll(async () => { await drop() })

type PaidTier = 'pro' | 'pro_max' | 'team'

/**
 * A fresh organization per test.
 *
 * Credit grants accumulate, and sharing one organization made a later "there are no credits" assertion
 * quietly spend an earlier test's leftover balance — passing by resolving successfully, which is the opposite
 * of what it claimed.
 */
async function freshOrganization(tier: PaidTier | 'free', stripeStatus = 'active') {
  ORG = uniqueId('sb-org')
  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: ORG })
  principal = { organizationId: ORG, userId: USER, organizationRole: 'owner', requestId: uniqueId('req') } as never
  // `free` is the *absence* of a subscription row, not a row saying `free`:
  // `billing_subscriptions_tier_check` only admits pro/pro_max/team, so the schema cannot represent a free
  // subscription at all. Free is therefore whatever an organization is before it pays.
  if (tier !== 'free') await seedSubscription(tier, stripeStatus)
}

async function seedSubscription(tier: PaidTier, stripeStatus: string) {
  const customerId = uniqueId('customer')
  await db.insert(billingCustomers).values({
    id: customerId, organizationId: ORG, livemode: false,
    stripeCustomerId: `cus_${customerId}`, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(billingSubscriptions).values({
    id: uniqueId('sub'), organizationId: ORG, customerId, livemode: false,
    catalogKey: `${tier}_monthly`, tier, interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('stripe-sub'), stripeStatus, providerSyncedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(),
  })
}

async function seedCredits(units: number) {
  await tenantTransaction(db, ORG, (tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
    source: 'promotional', units, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
}

const readReservation = async (id: string) => {
  const [row] = await db.select().from(billingCreditReservations).where(eq(billingCreditReservations.id, id))
  return row
}

interface RunOptions {
  operation?: 'generate' | 'regenerate'
  usable?: boolean
  providerInvoked?: boolean
  idempotencyKey?: string
  confirmation?: { acceptedUnits: number; acceptedRateCardVersion: number }
}

/** A completed run reporting the two facts the price depends on. */
const run = (reservationId: string, options: RunOptions = {}) => {
  const operation = options.operation ?? 'generate'
  return tenantTransaction(db, ORG, (tx) => withSolutionsCredits(
    tx as never, principal,
    {
      operation,
      reservationId,
      idempotencyKey: options.idempotencyKey ?? uniqueId('idem'),
      confirmation: options.confirmation ?? (operation === 'generate'
        ? CONFIRMED
        : { acceptedUnits: REGENERATE_PRICE, acceptedRateCardVersion: RATE_CARDS.solutions_regenerate.version }),
    },
    async () => ({
      result: 'routes',
      usable: options.usable ?? true,
      providerInvoked: options.providerInvoked ?? true,
      providerReference: 'ref-1',
    }),
  ))
}

beforeEach(async () => { await freshOrganization('pro') })

describe('nothing reaches a provider before a reservation exists', () => {
  it('has a reserved row by the time the work runs', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')
    let stateWhenWorkRan: string | null = null

    await tenantTransaction(db, ORG, (tx) => withSolutionsCredits(
      tx as never, principal,
      { operation: 'generate', reservationId, idempotencyKey: uniqueId('idem'), confirmation: CONFIRMED },
      async () => {
        // Read from inside the callback. If the reservation were created after — or concurrently with — the
        // work, this would be null.
        const [row] = await tx.select().from(billingCreditReservations).where(eq(billingCreditReservations.id, reservationId))
        stateWhenWorkRan = row?.state ?? null
        return { result: 'x', usable: true, providerInvoked: true, providerReference: null }
      },
    ))
    expect(stateWhenWorkRan).toBe('reserved')
  })

  it('never runs the work when the feature flag is off', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')
    let ran = false
    flagState.paidGenerationEnabled = false
    try {
      await expect(tenantTransaction(db, ORG, (tx) => withSolutionsCredits(
        tx as never, principal,
        { operation: 'generate', reservationId, idempotencyKey: uniqueId('idem'), confirmation: CONFIRMED },
        async () => { ran = true; return { result: 'x', usable: true, providerInvoked: true, providerReference: null } },
      ))).rejects.toMatchObject({ code: 'feature_disabled' })
    } finally {
      flagState.paidGenerationEnabled = true
    }
    // A disabled feature must not create a reservation it then has to release, and must not be reported as an
    // entitlement problem — that sends a user to buy an upgrade that changes nothing.
    expect(ran).toBe(false)
    expect(await readReservation(reservationId)).toBeUndefined()
  })
})

describe('the confirmed charge is a promise, not a formality', () => {
  it('refuses without a confirmation', async () => {
    await seedCredits(100)
    await expect(run(uniqueId('res'), {
      confirmation: { acceptedUnits: 0, acceptedRateCardVersion: RATE_CARDS.solutions_generate.version },
    })).rejects.toMatchObject({ code: 'confirmation_required' })
  })

  it('refuses a confirmation for a different amount or version', async () => {
    // A client that cached a cheaper price must not bill at it; one that cached a dearer price must not
    // overcharge either. Both are refused and asked to re-confirm against the current card.
    await seedCredits(100)
    for (const stale of [
      { acceptedUnits: GENERATE_PRICE - 1, acceptedRateCardVersion: RATE_CARDS.solutions_generate.version },
      { acceptedUnits: GENERATE_PRICE + 50, acceptedRateCardVersion: RATE_CARDS.solutions_generate.version },
      { acceptedUnits: GENERATE_PRICE, acceptedRateCardVersion: RATE_CARDS.solutions_generate.version + 1 },
    ]) {
      await expect(run(uniqueId('res'), { confirmation: stale }))
        .rejects.toMatchObject({ code: 'confirmed_amount_stale' })
    }
  })

  it('refuses a generate confirmation reused for a regenerate', async () => {
    // The two prices differ, so a client that confirmed one and sent the other would charge the wrong amount.
    // Caught by the same equality check rather than by a separate rule.
    await seedCredits(100)
    await expect(run(uniqueId('res'), { operation: 'regenerate', confirmation: CONFIRMED }))
      .rejects.toBeInstanceOf(SolutionsBillingError)
  })

  it('describes the exact charge and its version, and nothing else', () => {
    // Deliberately not a balance: the balance changes between render and confirm, and a client deciding
    // affordability for itself would duplicate a decision the platform has to make at reservation time.
    expect(describeSolutionsCharge('generate')).toEqual({
      operationKey: 'solutions_generate', units: GENERATE_PRICE, rateCardVersion: RATE_CARDS.solutions_generate.version,
    })
    expect(describeSolutionsCharge('regenerate').units).toBe(REGENERATE_PRICE)
  })
})

describe('tier and balance', () => {
  it('refuses a Free organization even when it holds credits', async () => {
    // Credits granted promotionally do not buy entitlement: the tier gate comes first, so a free organization
    // with a hundred units still cannot start a paid Solutions run.
    await freshOrganization('free')
    await seedCredits(100)
    await expect(run(uniqueId('res'))).rejects.toMatchObject({ code: 'insufficient_entitlement' })
  })

  it('allows the tiers above the minimum, not only the minimum itself', async () => {
    // `minimumTier: 'pro'` is a floor. A team organization paying more than the floor must not be refused for
    // failing to match it exactly.
    for (const tier of ['pro_max', 'team'] as const) {
      await freshOrganization(tier)
      await seedCredits(100)
      expect((await run(uniqueId('res'))).settledUnits).toBe(GENERATE_PRICE)
    }
  })

  it('refuses a suspended subscription even on a paid tier', async () => {
    // A past-due Pro organization is on the right tier and must still be refused — the tier is what they
    // bought, the status is whether they are paying for it.
    await freshOrganization('pro', 'past_due')
    await seedCredits(100)
    await expect(run(uniqueId('res'))).rejects.toMatchObject({ code: 'insufficient_entitlement' })
  })

  it('refuses when the balance cannot cover the whole price', async () => {
    // One credit short, not zero: a fixed price is reserved in full or not at all, so a partially affordable
    // run must be refused rather than started and truncated.
    await seedCredits(GENERATE_PRICE - 1)
    await expect(run(uniqueId('res'))).rejects.toBeInstanceOf(FeatureBillingError)
  })

  it('allows a member, not only an owner', async () => {
    // Generating advice is ordinary work for anyone in the organization. Restricting it to owners would make a
    // team of five into a team of one, and billing is organization-scoped rather than per-seat.
    await seedCredits(100)
    principal = { organizationId: ORG, userId: MEMBER, organizationRole: 'member', requestId: uniqueId('req') } as never
    expect((await run(uniqueId('res'))).settledUnits).toBe(GENERATE_PRICE)
  })
})

describe('the settlement is the fixed price', () => {
  it('settles the full generate price and records the governing version', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')
    expect((await run(reservationId)).settledUnits).toBe(GENERATE_PRICE)
    const row = await readReservation(reservationId)
    expect(row.state).toBe('settled')
    expect(row.settledUnits).toBe(GENERATE_PRICE)
    // The version that governed this reservation is recorded, so a later rate change cannot reinterpret it.
    expect(row.rateCardVersion).toBe(RATE_CARDS.solutions_generate.version)
  })

  it('charges generate the same whether or not a provider ran', async () => {
    /**
     * A brief the deterministic composer answered outright is not a cheaper product — it is the same product
     * delivered more efficiently, and spec.md prices generate on "a usable result" with no provider condition.
     * Discounting it would also give a user an incentive to phrase briefs so the LLM lanes stay out.
     */
    await seedCredits(100)
    const withProvider = await run(uniqueId('res'), { providerInvoked: true })
    const withoutProvider = await run(uniqueId('res'), { providerInvoked: false })
    expect(withoutProvider.settledUnits).toBe(withProvider.settledUnits)
    expect(withoutProvider.settledUnits).toBe(GENERATE_PRICE)
  })

  it('settles the regenerate price only when the rerun invoked a provider', async () => {
    // spec.md conditions this one explicitly: "fixed 3-credit settlement when the rerun invokes providers".
    await seedCredits(100)
    const billed = uniqueId('res')
    const free = uniqueId('res')
    expect((await run(billed, { operation: 'regenerate', providerInvoked: true })).settledUnits).toBe(REGENERATE_PRICE)
    expect((await run(free, { operation: 'regenerate', providerInvoked: false })).settledUnits).toBe(0)
    // Settled, not released: the user got a fresh answer, it simply cost nothing to serve. A release would say
    // they got nothing.
    expect(await readReservation(free)).toMatchObject({ state: 'settled', settledUnits: 0 })
  })

  it('never settles more than the reservation held', async () => {
    // The price and the reservation come from the same rate card, so this is an identity rather than a
    // comparison — but an identity worth asserting: a future edit that set `maxUnits` below the settled price
    // would violate `billing_credit_reservations_units_check` at runtime, in production, mid-charge.
    await seedCredits(100)
    const reservationId = uniqueId('res')
    await run(reservationId)
    const row = await readReservation(reservationId)
    expect(row.settledUnits).toBeLessThanOrEqual(row.maximumUnits)
  })
})

describe('usable settles, unusable releases', () => {
  it('releases a completed run whose result is unusable', async () => {
    /**
     * The provider did not throw, so a catch-based boundary would not fire — and the user has nothing to act
     * on. Charging for a run whose every route came back unavailable because the provider degraded is charging
     * for a computation, and what this product sells is advice.
     */
    await seedCredits(100)
    const reservationId = uniqueId('res')
    const outcome = await run(reservationId, { usable: false })
    expect(outcome.released).toBe(true)
    expect(outcome.settledUnits).toBe(0)
    expect((await readReservation(reservationId)).state).toBe('released')
  })

  it('settles a usable partial result', async () => {
    // Two routes offered, the third unexplained. The user has advice; charging the full price is correct —
    // there is no partial price, and inventing one would make the confirmed figure conditional.
    await seedCredits(100)
    const reservationId = uniqueId('res')
    const outcome = await run(reservationId, { usable: true })
    expect(outcome.released).toBe(false)
    expect(outcome.settledUnits).toBe(GENERATE_PRICE)
  })

  /**
   * The release is only observable when the caller commits.
   *
   * A first version of these two tests let the error escape `tenantTransaction`, then asserted the row was
   * `released` — and found no row at all, because the rollback took the reservation with it. That is the
   * behaviour `billing.ts` documents, so the test was wrong rather than the code. Catching inside the
   * transaction reproduces the caller that actually needs the release: a worker that fails one brief in a batch
   * and commits the rest.
   */
  const runCatchingInside = async (reservationId: string, work: () => Promise<never>) =>
    tenantTransaction(db, ORG, async (tx) => {
      try {
        await withSolutionsCredits(
          tx as never, principal,
          { operation: 'generate', reservationId, idempotencyKey: uniqueId('idem'), confirmation: CONFIRMED },
          work,
        )
        return null
      } catch (error) {
        return (error as Error).message
      }
    })

  it('releases when the work throws before touching a provider', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')
    const message = await runCatchingInside(reservationId, async () => { throw new Error('timed out before the provider') })
    expect(message).toBe('timed out before the provider')
    expect((await readReservation(reservationId)).state).toBe('released')
  })

  it('releases when the work throws after the provider answered', async () => {
    // A timeout on our side after the provider billed. The hold still goes back: charging the price for output
    // nobody received is the one outcome the user can legitimately dispute.
    await seedCredits(100)
    const reservationId = uniqueId('res')
    const message = await runCatchingInside(reservationId, async () => {
      await Promise.resolve()
      throw new Error('timed out after the provider')
    })
    expect(message).toBe('timed out after the provider')
    expect((await readReservation(reservationId)).state).toBe('released')
  })

  it('rolls the reservation away entirely when the caller lets the error escape', async () => {
    // The other half of the same contract, asserted rather than assumed: a route that does not catch leaves no
    // hold behind at all, which is why the release above is for batch callers and not a general safety net.
    await seedCredits(100)
    const reservationId = uniqueId('res')
    await expect(tenantTransaction(db, ORG, (tx) => withSolutionsCredits(
      tx as never, principal,
      { operation: 'generate', reservationId, idempotencyKey: uniqueId('idem'), confirmation: CONFIRMED },
      async () => { throw new Error('escaped') },
    ))).rejects.toThrow('escaped')
    expect(await readReservation(reservationId)).toBeUndefined()
  })

  it('propagates the original error when the release itself fails', async () => {
    // Someone debugging a failed brief needs the provider's reason, not a bookkeeping error that happened
    // afterwards. Reproduced by releasing a reservation id the platform will not find.
    await seedCredits(100)
    await expect(tenantTransaction(db, ORG, async (tx) => {
      const inner = withSolutionsCredits(
        tx as never, principal,
        { operation: 'generate', reservationId: uniqueId('res'), idempotencyKey: uniqueId('idem'), confirmation: CONFIRMED },
        async () => { throw new Error('provider exploded') },
      )
      return inner
    })).rejects.toThrow('provider exploded')
  })
})

describe('a duplicate request replays instead of double-charging', () => {
  it('reuses the reservation for the same idempotency key', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')
    const idempotencyKey = uniqueId('idem')

    const first = await run(reservationId, { idempotencyKey })
    const second = await run(reservationId, { idempotencyKey })

    expect(second.settledUnits).toBe(first.settledUnits)
    const rows = await db.select().from(billingCreditReservations).where(eq(billingCreditReservations.id, reservationId))
    // One row, one charge. A second row would mean a user who double-clicked paid twice.
    expect(rows).toHaveLength(1)
    expect(rows[0].settledUnits).toBe(GENERATE_PRICE)
  })

  it('charges once when two identical requests race', async () => {
    await seedCredits(100)
    const reservationId = uniqueId('res')
    const idempotencyKey = uniqueId('idem')

    const outcomes = await Promise.allSettled([
      run(reservationId, { idempotencyKey }),
      run(reservationId, { idempotencyKey }),
    ])
    // One may lose the race and reject; what must not happen is two charges.
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true)
    const rows = await db.select().from(billingCreditReservations).where(eq(billingCreditReservations.id, reservationId))
    expect(rows).toHaveLength(1)
    expect(rows[0].settledUnits).toBe(GENERATE_PRICE)
  })
})

describe('reconciliation can tell the outcomes apart', () => {
  it('leaves a distinguishable row for each terminal state', async () => {
    /**
     * The point of settling zero for a provider-free regenerate rather than releasing it, and of releasing an
     * unusable result rather than settling it: the three outcomes have to be distinguishable after the fact. A
     * reconciliation job that could not tell a free rerun from an abandoned run would have no way to find
     * genuine leaks.
     */
    await seedCredits(200)
    const charged = uniqueId('res')
    const freeRerun = uniqueId('res')
    const released = uniqueId('res')

    await run(charged)
    await run(freeRerun, { operation: 'regenerate', providerInvoked: false })
    await run(released, { usable: false })

    expect(await readReservation(charged)).toMatchObject({ state: 'settled', settledUnits: GENERATE_PRICE })
    expect(await readReservation(freeRerun)).toMatchObject({ state: 'settled', settledUnits: 0 })
    expect((await readReservation(released)).state).toBe('released')
  })

  it('records the provider reference for a settled run', async () => {
    await seedCredits(100)
    // The provider's own id, so a disputed charge can be traced to their invoice rather than to our guess.
    expect((await run(uniqueId('res'))).providerReference).toBe('ref-1')
  })

  it('resolves a historical run against its own rate-card version after a price change', async () => {
    /**
     * The plan's verify line: "historical runs resolve their original rate-card version after a future change."
     *
     * A real version bump, not a mock — `RATE_CARDS` is the registry, so mutating it is what a future release
     * does. The already-settled reservation must keep saying version 1 and keep saying it was charged the old
     * price, because an invoice that changed retroactively is a billing incident. A new reservation taken after
     * the bump must record the new version, or history would be indistinguishable from the present.
     */
    await seedCredits(200)
    const before = uniqueId('res')
    await run(before)
    const settledBefore = await readReservation(before)

    const original = { ...RATE_CARDS.solutions_generate }
    RATE_CARDS.solutions_generate = { ...original, version: original.version + 1, maxUnits: original.maxUnits + 4 }
    try {
      const after = uniqueId('res')
      await run(after, {
        confirmation: {
          acceptedUnits: RATE_CARDS.solutions_generate.maxUnits,
          acceptedRateCardVersion: RATE_CARDS.solutions_generate.version,
        },
      })

      const historical = await readReservation(before)
      expect(historical.rateCardVersion).toBe(settledBefore.rateCardVersion)
      expect(historical.settledUnits).toBe(original.maxUnits)

      const current = await readReservation(after)
      expect(current.rateCardVersion).toBe(original.version + 1)
      expect(current.settledUnits).toBe(original.maxUnits + 4)
    } finally {
      RATE_CARDS.solutions_generate = original
    }
  })
})
