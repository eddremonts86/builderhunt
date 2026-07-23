import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { billingCreditGrants, billingCustomers, billingWebhookEvents, organizations } from '../db/schema'
import type { EventRetriever } from './worker'
import { replayBillingWebhookEvent, ReplayError, runBillingWorker } from './worker'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `worker-${label}-${counter}`
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('billing_worker')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

async function insertPendingEvent(overrides: Partial<{ status: string; nextAttemptAt: Date | null; attempts: number; eventType: string }> = {}): Promise<{ id: string; stripeEventId: string }> {
  const id = uniqueId('row')
  const stripeEventId = uniqueId('evt')
  await db.insert(billingWebhookEvents).values({
    id, livemode: false, stripeEventId, apiVersion: '2026-06-24.dahlia',
    objectType: 'unknown', eventType: overrides.eventType ?? 'some.unrecognized.event',
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 0,
    nextAttemptAt: overrides.nextAttemptAt ?? null,
    payloadEncrypted: 'test-encrypted-payload',
  })
  return { id, stripeEventId }
}

function fakeRetriever(events: Map<string, Stripe.Event | 'missing' | Error>): EventRetriever {
  return {
    async retrieveEvent(stripeEventId: string) {
      const entry = events.get(stripeEventId)
      if (entry === undefined || entry === 'missing') return null
      if (entry instanceof Error) throw entry
      return entry
    },
  }
}

function unrecognizedEvent(stripeEventId: string): Stripe.Event {
  return {
    id: stripeEventId, type: 'some.unrecognized.event', created: 1780000000, livemode: false,
    api_version: '2026-06-24.dahlia', data: { object: { id: 'x', object: 'x' } },
  } as unknown as Stripe.Event
}

describe('runBillingWorker — basic claim and process', () => {
  it('claims a pending event, processes it, and marks it processed', async () => {
    const { id, stripeEventId } = await insertPendingEvent()
    const retriever = fakeRetriever(new Map([[stripeEventId, unrecognizedEvent(stripeEventId)]]))

    const summary = await runBillingWorker({ retriever, db })

    expect(summary.claimedEvents).toBe(1)
    expect(summary.processedEvents).toBe(1)
    const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id))
    expect(row.status).toBe('processed')
    expect(row.processedAt).not.toBeNull()
  })

  it('does not re-claim an already-processed event on a later run', async () => {
    const { stripeEventId } = await insertPendingEvent()
    const retriever = fakeRetriever(new Map([[stripeEventId, unrecognizedEvent(stripeEventId)]]))

    await runBillingWorker({ retriever, db })
    const second = await runBillingWorker({ retriever, db })

    expect(second.claimedEvents).toBe(0)
  })

  it('a deferred outcome leaves the row pending (retryable), never marked processed', async () => {
    const { id, stripeEventId } = await insertPendingEvent({ eventType: 'payment_intent.succeeded' })
    const deferredEvent = {
      id: stripeEventId, type: 'payment_intent.succeeded', created: 1780000000, livemode: false,
      api_version: '2026-06-24.dahlia', data: { object: { id: 'pi_x', object: 'payment_intent' } },
    } as unknown as Stripe.Event
    const retriever = fakeRetriever(new Map([[stripeEventId, deferredEvent]]))

    const summary = await runBillingWorker({ retriever, db })

    expect(summary.deferredEvents).toBe(1)
    const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id))
    expect(row.status).toBe('pending')
    expect(row.processedAt).toBeNull()
  })

  it('dead-letters an event Stripe no longer retains', async () => {
    const { id, stripeEventId } = await insertPendingEvent()
    const retriever = fakeRetriever(new Map([[stripeEventId, 'missing']]))

    const summary = await runBillingWorker({ retriever, db })

    expect(summary.deadLetteredEvents).toBe(1)
    const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id))
    expect(row.status).toBe('failed')
  })
})

describe('runBillingWorker — concurrent claims never double-process the same row', () => {
  it('two concurrent runs split a batch of pending events with no overlap', async () => {
    const rows = await Promise.all(Array.from({ length: 6 }, () => insertPendingEvent()))
    const eventMap = new Map<string, Stripe.Event | 'missing' | Error>(rows.map((r) => [r.stripeEventId, unrecognizedEvent(r.stripeEventId)]))
    const retriever = fakeRetriever(eventMap)

    const [first, second] = await Promise.all([
      runBillingWorker({ retriever, db, batchSize: 10 }),
      runBillingWorker({ retriever, db, batchSize: 10 }),
    ])

    const claimedIds = [...first.eventResults, ...second.eventResults].map((r) => r.eventRowId)
    expect(new Set(claimedIds).size).toBe(claimedIds.length) // no id claimed by both runs
    expect(first.claimedEvents + second.claimedEvents).toBe(6)

    const allRows = await db.select().from(billingWebhookEvents)
    const ourRows = allRows.filter((r) => rows.some((seed) => seed.id === r.id))
    expect(ourRows.every((r) => r.status === 'processed')).toBe(true)
  })
})

describe('runBillingWorker — crashed lease reclaim', () => {
  it('reclaims a row stuck in "processing" whose lease has already expired', async () => {
    const { id, stripeEventId } = await insertPendingEvent({ status: 'processing', nextAttemptAt: new Date(Date.now() - 60_000), attempts: 1 })
    const retriever = fakeRetriever(new Map([[stripeEventId, unrecognizedEvent(stripeEventId)]]))

    const summary = await runBillingWorker({ retriever, db })

    expect(summary.claimedEvents).toBe(1)
    const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id))
    expect(row.status).toBe('processed')
  })

  it('does not reclaim a "processing" row whose lease has not expired yet', async () => {
    const { stripeEventId } = await insertPendingEvent({ status: 'processing', nextAttemptAt: new Date(Date.now() + 60_000), attempts: 1 })
    const retriever = fakeRetriever(new Map([[stripeEventId, unrecognizedEvent(stripeEventId)]]))

    const summary = await runBillingWorker({ retriever, db })

    expect(summary.claimedEvents).toBe(0)
  })
})

describe('runBillingWorker — poison event handling', () => {
  it('schedules a retry with backoff when the handler throws, below max attempts', async () => {
    const { id, stripeEventId } = await insertPendingEvent({ attempts: 0 })
    const retriever = fakeRetriever(new Map([[stripeEventId, new Error('processing exploded')]]))

    const summary = await runBillingWorker({ retriever, db, maxAttempts: 8 })

    expect(summary.retryScheduledEvents).toBe(1)
    const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id))
    expect(row.status).toBe('pending')
    expect(row.lastError).toContain('processing exploded')
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('dead-letters a poison event once it has exhausted max attempts', async () => {
    const { id, stripeEventId } = await insertPendingEvent({ attempts: 7 })
    const retriever = fakeRetriever(new Map([[stripeEventId, new Error('still exploding')]]))

    const summary = await runBillingWorker({ retriever, db, maxAttempts: 8 })

    expect(summary.deadLetteredEvents).toBe(1)
    const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id))
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('still exploding')
  })

  it('a dead-lettered event is never claimed again automatically', async () => {
    const { id, stripeEventId } = await insertPendingEvent({ attempts: 7 })
    const retriever = fakeRetriever(new Map([[stripeEventId, new Error('boom')]]))
    await runBillingWorker({ retriever, db, maxAttempts: 8 })

    const secondRunRetriever = fakeRetriever(new Map([[stripeEventId, unrecognizedEvent(stripeEventId)]]))
    const summary = await runBillingWorker({ retriever: secondRunRetriever, db })

    expect(summary.claimedEvents).toBe(0)
    const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id))
    expect(row.status).toBe('failed')
  })
})

describe('replayBillingWebhookEvent', () => {
  it('re-processes an event by row id, regardless of its current status', async () => {
    const { id, stripeEventId } = await insertPendingEvent({ status: 'failed', attempts: 8 })
    const retriever = fakeRetriever(new Map([[stripeEventId, unrecognizedEvent(stripeEventId)]]))

    const result = await replayBillingWebhookEvent(id, { retriever, db })

    expect(result.result).toBe('processed')
    const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id))
    expect(row.status).toBe('processed')
  })

  it('replaying an already-processed event is a safe idempotent no-op', async () => {
    const { id, stripeEventId } = await insertPendingEvent()
    const retriever = fakeRetriever(new Map([[stripeEventId, unrecognizedEvent(stripeEventId)]]))
    await runBillingWorker({ retriever, db })

    const result = await replayBillingWebhookEvent(id, { retriever, db })

    expect(result.result).toBe('processed')
  })

  it('throws a typed ReplayError for an unknown event row id', async () => {
    const retriever = fakeRetriever(new Map())
    await expect(replayBillingWebhookEvent('does-not-exist', { retriever, db })).rejects.toBeInstanceOf(ReplayError)
  })
})

describe('runBillingWorker — credit grant expiry sweep', () => {
  it('expires an active grant past its natural expiry', async () => {
    const organizationId = uniqueId('org')
    await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
    const customerId = uniqueId('cust')
    await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
    const grantId = uniqueId('grant')
    await db.insert(billingCreditGrants).values({
      id: grantId, organizationId, source: 'promotional', originalUnits: 100, remainingUnits: 50,
      state: 'active', expiresAt: new Date(Date.now() - 60_000),
    })

    const retriever = fakeRetriever(new Map())
    const summary = await runBillingWorker({ retriever, db })

    expect(summary.expiredGrants).toBeGreaterThanOrEqual(1)
    const [grant] = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.id, grantId))
    expect(grant.state).toBe('expired')
    expect(grant.remainingUnits).toBe(0)
  })

  it('does not touch a grant that has not expired yet', async () => {
    const organizationId = uniqueId('org')
    await db.insert(organizations).values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date() })
    const customerId = uniqueId('cust')
    await db.insert(billingCustomers).values({ id: customerId, organizationId, livemode: false, stripeCustomerId: `cus_${customerId}` })
    const grantId = uniqueId('grant')
    await db.insert(billingCreditGrants).values({
      id: grantId, organizationId, source: 'promotional', originalUnits: 100, remainingUnits: 100,
      state: 'active', expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    const retriever = fakeRetriever(new Map())
    await runBillingWorker({ retriever, db })

    const [grant] = await db.select().from(billingCreditGrants).where(eq(billingCreditGrants.id, grantId))
    expect(grant.state).toBe('active')
  })
})
