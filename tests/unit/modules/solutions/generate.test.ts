/**
 * The end-to-end generation flow (plan 43 Phase 8, "Connect the end-to-end generation flow").
 *
 * Real disposable Postgres, real billing platform, real composer, fake provider. The catalog is empty on
 * purpose in most cases: an empty catalog still produces three routes — all `unavailable`, each with a reason —
 * and that is the honest baseline. A flow that only worked with a populated catalog would be untested against
 * the state every new deployment starts in.
 *
 * The plan's verify line asks browser tests to prove "no provider access before confirmation, exact visible
 * charge, partial-source status, cancellation release". The first and last are properties of *this* module and
 * are proven here against the real ledger; the visible charge and the status rendering are proven in
 * `components/SolutionsPage.test.tsx`, where the DOM is.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { getAvailableCreditBalance, grantCredits } from '~/shared/lib/billing/credits'
import { authUsers, billingCreditReservations, billingCustomers, billingSubscriptions, organizations } from '~/shared/lib/db/schema'
import { RATE_CARDS } from '~/shared/lib/billing/rate-cards'
import { tenantTransaction } from '../../helpers/tenant-transaction'

const flagState = vi.hoisted(() => ({ paidGenerationEnabled: true, interpretationEnabled: false, explanationEnabled: false }))
vi.mock('~/shared/lib/solutions/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/solutions/config')>()
  return { ...actual, getSolutionsFeatureFlags: () => ({ ...actual.getSolutionsFeatureFlags(), ...flagState }) }
})

const { generateSolutions } = await import('~/modules/solutions/server/generate')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const USER = 'gen-user'
const PRICE = RATE_CARDS.solutions_generate.maxUnits
const CONFIRMED = { acceptedUnits: PRICE, acceptedRateCardVersion: RATE_CARDS.solutions_generate.version }
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`
let ORG = ''
let principal = {} as never

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('solutions_generate')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: USER, name: 'Gen', email: 'gen@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  ORG = uniqueId('gen-org')
  principal = { organizationId: ORG, userId: USER, organizationRole: 'owner', requestId: uniqueId('req') } as never
  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: ORG })
  const customerId = uniqueId('customer')
  await db.insert(billingCustomers).values({
    id: customerId, organizationId: ORG, livemode: false,
    stripeCustomerId: `cus_${customerId}`, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(billingSubscriptions).values({
    id: uniqueId('sub'), organizationId: ORG, customerId, livemode: false,
    catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('stripe'), stripeStatus: 'active', providerSyncedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(),
  })
  await tenantTransaction(db, ORG, (tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
    source: 'promotional', units: 200, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
})

const generate = (overrides: Record<string, unknown> = {}) =>
  tenantTransaction(db, ORG, (tx) => generateSolutions(tx as never, principal, {
    briefText: 'We need to translate 200 product pages into German.',
    confirmation: CONFIRMED,
    idempotencyKey: uniqueId('idem'),
    reservationId: uniqueId('res'),
    db,
    ...overrides,
  } as never))

const readReservation = async (id: string) => {
  const [row] = await db.select().from(billingCreditReservations).where(eq(billingCreditReservations.id, id))
  return row
}

describe('a run against an empty catalog', () => {
  it('produces three routes, every one unavailable with a reason', async () => {
    /**
     * The state every new deployment starts in. Three `unavailable` routes each naming why is a real answer;
     * an error page or an empty screen would leave the user unable to tell "we found nothing" from "it broke".
     */
    const outcome = await generate()
    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') return
    expect(outcome.routes.map((route) => route.routeType)).toEqual(['human', 'ai', 'hybrid'])
    for (const route of outcome.routes) {
      expect(route.status).toBe('unavailable')
      expect(route.unavailableReason).toBeTruthy()
    }
  })

  it('charges the fixed price, because the user got an answer', async () => {
    // "No option fits, and here is why for each lane" is the product working, not failing.
    const outcome = await generate()
    expect(outcome.settledUnits).toBe(PRICE)
  })

  it('records a reproducible trace', async () => {
    const first = await generate()
    const second = await generate()
    if (first.status !== 'complete' || second.status !== 'complete') throw new Error('expected complete runs')
    // Same brief, same catalog, same composition. Without this a stored recommendation cannot be audited.
    expect(second.trace.compositionHash).toBe(first.trace.compositionHash)
    expect(first.trace.composerVersion).toBe('composer-1')
  })
})

describe('nothing provider-backed happens before the reservation', () => {
  it('has a reserved row by the time interpretation starts', async () => {
    let stateAtFirstStage: string | null = null
    const reservationId = uniqueId('res')
    await tenantTransaction(db, ORG, (tx) => generateSolutions(tx as never, principal, {
      briefText: 'Translate 200 product pages into German.',
      confirmation: CONFIRMED,
      idempotencyKey: uniqueId('idem'),
      reservationId,
      db,
      onProgress: async (progress: { stage: string }) => {
        if (progress.stage !== 'interpreting' || stateAtFirstStage) return
        const [row] = await tx.select().from(billingCreditReservations).where(eq(billingCreditReservations.id, reservationId))
        stateAtFirstStage = row?.state ?? null
      },
    } as never))
    expect(stateAtFirstStage).toBe('reserved')
  })

  it('refuses a stale confirmation without running anything', async () => {
    const reservationId = uniqueId('res')
    const stages: string[] = []
    await expect(tenantTransaction(db, ORG, (tx) => generateSolutions(tx as never, principal, {
      briefText: 'Translate 200 product pages.',
      confirmation: { acceptedUnits: PRICE + 5, acceptedRateCardVersion: 1 },
      idempotencyKey: uniqueId('idem'),
      reservationId,
      db,
      onProgress: (progress: { stage: string }) => { stages.push(progress.stage) },
    } as never))).rejects.toMatchObject({ code: 'confirmed_amount_stale' })
    expect(stages).toEqual([])
    expect(await readReservation(reservationId)).toBeUndefined()
  })

  it('reports every stage in order', async () => {
    const stages: string[] = []
    await generate({ onProgress: (progress: { stage: string }) => stages.push(progress.stage) })
    expect(stages).toEqual(['interpreting', 'retrieving', 'composing', 'explaining', 'done'])
  })
})

describe('cancellation', () => {
  it('releases the hold when the caller aborts', async () => {
    /**
     * "Cancel" in the UI is the browser dropping the connection, which fires `request.signal`. The run throws,
     * and the throw releases the reservation through the same path as any other failure — so the assertion that
     * matters is the reservation's terminal state, not the error.
     */
    const controller = new AbortController()
    const reservationId = uniqueId('res')
    const message = await tenantTransaction(db, ORG, async (tx) => {
      try {
        await generateSolutions(tx as never, principal, {
          briefText: 'Translate 200 product pages.',
          confirmation: CONFIRMED,
          idempotencyKey: uniqueId('idem'),
          reservationId,
          db,
          signal: controller.signal,
          onProgress: (progress: { stage: string }) => { if (progress.stage === 'interpreting') controller.abort() },
        } as never)
        return null
      } catch (error) {
        return (error as Error).name
      }
    })
    expect(message).toBe('AbortError')
    expect((await readReservation(reservationId)).state).toBe('released')
  })

  it('charges nothing for a cancelled run', async () => {
    const controller = new AbortController()
    const reservationId = uniqueId('res')
    await tenantTransaction(db, ORG, async (tx) => {
      try {
        await generateSolutions(tx as never, principal, {
          briefText: 'Translate 200 pages.',
          confirmation: CONFIRMED,
          idempotencyKey: uniqueId('idem'),
          reservationId,
          db,
          signal: controller.signal,
          onProgress: () => controller.abort(),
        } as never)
      } catch {
        // The release is what this asserts; the error itself is asserted above.
      }
    })
    // The platform records a released reservation as settled-zero rather than leaving the column null, so the
    // claim worth asserting is the balance: nothing left the ledger.
    const row = await readReservation(reservationId)
    expect(row.state).toBe('released')
    expect(row.settledUnits ?? 0).toBe(0)
    const balance = await tenantTransaction(db, ORG, (tx) => getAvailableCreditBalance(tx, ORG))
    expect(balance).toBe(200)
  })
})

describe('an unreadable brief', () => {
  it('is released, not charged', async () => {
    /**
     * With interpretation off, the deterministic fallback matches capability keywords — and a brief with none
     * yields no brief at all rather than a placeholder capability the catalog has never heard of. The user has
     * nothing to act on, so the hold goes back.
     */
    const reservationId = uniqueId('res')
    const outcome = await generate({
      briefText: 'Please help us with the thing we discussed on the call.',
      reservationId,
    })
    expect(outcome.status).toBe('unreadable')
    expect(outcome.settledUnits).toBe(0)
    expect((await readReservation(reservationId)).state).toBe('released')
  })
})

describe('the feature flag', () => {
  it('refuses before touching the ledger', async () => {
    flagState.paidGenerationEnabled = false
    try {
      const reservationId = uniqueId('res')
      await expect(generate({ reservationId })).rejects.toMatchObject({ code: 'feature_disabled' })
      expect(await readReservation(reservationId)).toBeUndefined()
    } finally {
      flagState.paidGenerationEnabled = true
    }
  })

  it('still produces routes with both LLM flags off', async () => {
    // Retrieval is SQL and composition is arithmetic, so the deterministic path is a real product rather than a
    // degraded mode — and it costs no provider money at all.
    const outcome = await generate()
    expect(outcome.status).toBe('complete')
    if (outcome.status !== 'complete') return
    expect(outcome.interpretation.provenance).toBe('deterministic')
    expect(outcome.routeExplanations.every((explanation) => explanation.provenance === 'deterministic')).toBe(true)
  })
})
