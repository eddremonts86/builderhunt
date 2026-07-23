/**
 * Billing worker: claims durable `billing_webhook_events` rows and processes them, with bounded
 * retry/backoff and dead-lettering, plus a credit-grant expiry sweep (plans/stripe-billing-platform/
 * tasks.md §6 "Build billing worker and event replay"). Exposed via the existing authenticated
 * HTTP-cron pattern (`requirePlatformAdminPrincipal` + `auditPlatformAdminAction`, matching every
 * other `run-worker.ts` route in this codebase) rather than a new mechanism.
 *
 * Grace-period blocking after 7 days is now built (§7 task 6, `dunning.ts`) and swept below.
 * Auto-recharge triggering (§8 task 2, `auto-recharge.ts`) is also swept below —
 * `sweepAutoRecharge` evaluates every organization's rule once per tick via `maybeTriggerAutoRecharge`,
 * which does its own row-locking so two overlapping worker runs can't double-charge the same org.
 * Deduplicated financial notices (§10) remain OUT of this worker's scope today — no notification
 * channel exists yet for it to drive.
 *
 * ## Why the worker re-fetches from Stripe's Events API, not our own stored payload
 *
 * `webhook-inbox.ts` deliberately stores only a MINIMIZED payload (spec.md: "minimized, encrypted
 * where retained") — event/object identifiers, never the full Stripe object body (customer emails,
 * card data, line items, etc.). That is enough for our own audit trail, but NOT enough to re-run
 * `webhook-handlers.ts`'s handlers, which need the full object (subscription items/price, invoice
 * period, etc.). The correct, standard fix — and what real Stripe integrations do — is to re-fetch
 * the FULL original event from Stripe itself via `stripe.events.retrieve(eventId)` (Stripe retains
 * event bodies for 30 days), never to try to reconstruct it from our own deliberately-lossy local
 * copy. `EventRetriever` is the injected seam for this — production uses the real Stripe SDK; tests
 * inject a fake one returning canned fixtures, the same DI pattern this entire plan already uses for
 * `BillingProvider`.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type Stripe from 'stripe'
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { billingWebhookEvents } from '../db/schema'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { listActiveBillingCreditGrants } from '../repositories/billing'
import {
  listActiveAnnualBillingSubscriptions,
  listGracePeriodBillingSubscriptions,
  listWorkerOrganizationIds,
  markBillingSubscriptionPaymentBlocked,
  withWorkerOrganization,
} from '../repositories/billing-worker'
import { issueAnnualSubscriptionGrants } from './annual-grants'
import { maybeTriggerAutoRecharge } from './auto-recharge'
import { resolveSubscriptionCatalogEntryByKey } from './catalog'
import { expireCreditGrant } from './credits'
import { freezeIncludedGrantsForNonPayment, shouldBlockForNonPayment } from './dunning'
import type { BillingProvider } from './provider'
import { listPendingPackRefundIds, processPendingPackRefund } from './refunds'
import { processStripeWebhookEvent } from './webhook-handlers'

export interface EventRetriever {
  /** Returns `null` if Stripe no longer has the event (past its retention window) — never throws for a merely-missing event. */
  retrieveEvent(stripeEventId: string): Promise<Stripe.Event | null>
}

export function createStripeEventRetriever(): EventRetriever {
  return {
    async retrieveEvent(stripeEventId: string) {
      const { getStripeClient } = await import('./stripe-client')
      try {
        return (await getStripeClient().events.retrieve(stripeEventId)) as Stripe.Event
      } catch {
        return null
      }
    },
  }
}

export interface RunBillingWorkerOptions {
  retriever: EventRetriever
  /** Used by `sweepAutoRecharge` to create off-session PaymentIntents — the same DI seam every other billing service function takes. */
  provider: BillingProvider
  /** Defaults to the real `workerDb` singleton — tests inject a disposable database. */
  db?: PostgresJsDatabase | typeof workerDb
  /** How many pending/retryable events to claim in one run. */
  batchSize?: number
  /** How long a claimed row is considered "in flight" before another run may reclaim it (protects against a crashed worker holding a lease forever). */
  leaseSeconds?: number
  /** After this many attempts, a poison event is dead-lettered (`status: 'failed'`) instead of retried again. */
  maxAttempts?: number
  now?: () => Date
}

export interface WebhookEventProcessingResult {
  eventRowId: string
  stripeEventId: string
  result: 'processed' | 'deferred' | 'dead_lettered' | 'retry_scheduled'
  detail: string
}

export interface WorkerRunSummary {
  claimedEvents: number
  processedEvents: number
  deferredEvents: number
  deadLetteredEvents: number
  retryScheduledEvents: number
  expiredGrants: number
  annualGrantsIssued: number
  paymentBlocksApplied: number
  autoRechargeTriggered: number
  refundsProcessed: number
  eventResults: WebhookEventProcessingResult[]
}

const DEFAULT_BATCH_SIZE = 25
const DEFAULT_LEASE_SECONDS = 300
const DEFAULT_MAX_ATTEMPTS = 8

function backoffSeconds(attempts: number): number {
  // Exponential backoff, capped at 1 hour: 30s, 60s, 120s, ... 3600s.
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600)
}

interface ClaimedEvent {
  id: string
  livemode: boolean
  stripeEventId: string
  attempts: number
}

async function claimPendingEvents(
  db: PostgresJsDatabase | typeof workerDb,
  batchSize: number,
  leaseSeconds: number,
  now: Date,
): Promise<ClaimedEvent[]> {
  return db.transaction(async (tx) => {
    const eligible = await tx
      .select({ id: billingWebhookEvents.id })
      .from(billingWebhookEvents)
      .where(or(
        and(eq(billingWebhookEvents.status, 'pending'), or(isNull(billingWebhookEvents.nextAttemptAt), lte(billingWebhookEvents.nextAttemptAt, now))),
        and(eq(billingWebhookEvents.status, 'processing'), lte(billingWebhookEvents.nextAttemptAt, now)),
      ))
      .orderBy(billingWebhookEvents.receivedAt)
      .limit(batchSize)
      .for('update', { skipLocked: true })

    if (eligible.length === 0) return []

    const ids = eligible.map((row) => row.id)
    const claimed = await tx
      .update(billingWebhookEvents)
      .set({
        status: 'processing',
        attempts: sql`${billingWebhookEvents.attempts} + 1`,
        nextAttemptAt: new Date(now.getTime() + leaseSeconds * 1000),
      })
      .where(inArray(billingWebhookEvents.id, ids))
      .returning({
        id: billingWebhookEvents.id,
        livemode: billingWebhookEvents.livemode,
        stripeEventId: billingWebhookEvents.stripeEventId,
        attempts: billingWebhookEvents.attempts,
      })
    return claimed
  })
}

async function markProcessed(db: PostgresJsDatabase | typeof workerDb, id: string, now: Date): Promise<void> {
  await db.update(billingWebhookEvents).set({ status: 'processed', processedAt: now }).where(eq(billingWebhookEvents.id, id))
}

async function markPendingForRetry(db: PostgresJsDatabase | typeof workerDb, id: string, nextAttemptAt: Date, lastError: string | null): Promise<void> {
  await db.update(billingWebhookEvents).set({ status: 'pending', nextAttemptAt, lastError }).where(eq(billingWebhookEvents.id, id))
}

async function markDeadLettered(db: PostgresJsDatabase | typeof workerDb, id: string, lastError: string): Promise<void> {
  await db.update(billingWebhookEvents).set({ status: 'failed', lastError }).where(eq(billingWebhookEvents.id, id))
}

function redactError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown error'
}

async function processOneEvent(
  event: ClaimedEvent,
  options: { db: PostgresJsDatabase | typeof workerDb; retriever: EventRetriever; maxAttempts: number; now: Date },
): Promise<WebhookEventProcessingResult> {
  try {
    const fullEvent = await options.retriever.retrieveEvent(event.stripeEventId)
    if (!fullEvent) {
      await markDeadLettered(options.db, event.id, 'Event no longer retrievable from Stripe (past retention window)')
      return { eventRowId: event.id, stripeEventId: event.stripeEventId, result: 'dead_lettered', detail: 'Event not retrievable' }
    }

    const outcome = await processStripeWebhookEvent(fullEvent, { db: options.db, livemode: event.livemode })

    if (outcome.outcome === 'deferred') {
      // Leave it retryable indefinitely — nothing is wrong, the dependent infrastructure just
      // doesn't exist yet. Uses the same backoff schedule so it doesn't spin hot.
      await markPendingForRetry(options.db, event.id, new Date(options.now.getTime() + backoffSeconds(event.attempts) * 1000), null)
      return { eventRowId: event.id, stripeEventId: event.stripeEventId, result: 'deferred', detail: outcome.detail }
    }

    await markProcessed(options.db, event.id, options.now)
    return { eventRowId: event.id, stripeEventId: event.stripeEventId, result: 'processed', detail: outcome.detail }
  } catch (error) {
    const message = redactError(error)
    if (event.attempts >= options.maxAttempts) {
      await markDeadLettered(options.db, event.id, message)
      return { eventRowId: event.id, stripeEventId: event.stripeEventId, result: 'dead_lettered', detail: message }
    }
    await markPendingForRetry(options.db, event.id, new Date(options.now.getTime() + backoffSeconds(event.attempts) * 1000), message)
    return { eventRowId: event.id, stripeEventId: event.stripeEventId, result: 'retry_scheduled', detail: message }
  }
}

async function sweepExpiredCreditGrants(db: PostgresJsDatabase | typeof workerDb, now: Date): Promise<number> {
  const orgIds = await listWorkerOrganizationIds(db)
  let expired = 0
  for (const { id: organizationId } of orgIds) {
    await withWorkerOrganization(organizationId, async (tx) => {
      const activeGrants = await listActiveBillingCreditGrants(tx as WorkerTransaction, organizationId)
      for (const grant of activeGrants) {
        if (grant.expiresAt > now) continue
        await expireCreditGrant(tx as WorkerTransaction, {
          organizationId,
          grantId: grant.id,
          ledgerEntryId: `worker-expire-${grant.id}`,
          idempotencyKey: `worker-expire-${grant.id}`,
          reason: 'Reached natural expiry',
        })
        expired += 1
      }
    }, db)
  }
  return expired
}

/**
 * Windows 2-12 of every annual subscription still in good standing
 * (§7 "Issue annual subscription credits monthly") — a subscription that
 * lapses into any other status (canceled, unpaid, past_due, paused) simply
 * stops appearing in `listActiveAnnualBillingSubscriptions`, so no further
 * windows are ever issued for it; nothing needs to explicitly "stop" a
 * lapsed subscription's future grants.
 */
async function sweepAnnualSubscriptionGrants(db: PostgresJsDatabase | typeof workerDb, now: Date): Promise<number> {
  const orgIds = await listWorkerOrganizationIds(db)
  let issued = 0
  for (const { id: organizationId } of orgIds) {
    await withWorkerOrganization(organizationId, async (tx) => {
      const subscriptions = await listActiveAnnualBillingSubscriptions(tx as WorkerTransaction, organizationId)
      for (const subscription of subscriptions) {
        if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) continue
        const catalogEntry = resolveSubscriptionCatalogEntryByKey(subscription.catalogKey)
        if (!catalogEntry) continue
        issued += await issueAnnualSubscriptionGrants(tx as WorkerTransaction, organizationId, {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          monthlyCredits: catalogEntry.monthlyCredits,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
        }, now)
      }
    }, db)
  }
  return issued
}

/**
 * Grace periods (§7 task 6, "Implement seven-day dunning and recovery") that have run out — blocks
 * each one (marks `paymentBlockedAt` and freezes its included grants) exactly once. A subscription
 * that recovers before this ever runs simply stops appearing in `listGracePeriodBillingSubscriptions`
 * (its `gracePeriodEndsAt` was already cleared by the webhook handler), so there is nothing to
 * "un-decide" here — this sweep only ever moves a subscription forward into being blocked, never
 * the other direction.
 */
async function sweepNonPaymentBlocks(db: PostgresJsDatabase | typeof workerDb, now: Date): Promise<number> {
  const orgIds = await listWorkerOrganizationIds(db)
  let blocked = 0
  for (const { id: organizationId } of orgIds) {
    await withWorkerOrganization(organizationId, async (tx) => {
      const candidates = await listGracePeriodBillingSubscriptions(tx as WorkerTransaction, organizationId)
      for (const candidate of candidates) {
        if (!shouldBlockForNonPayment(candidate, now)) continue
        await freezeIncludedGrantsForNonPayment(tx as WorkerTransaction, organizationId, candidate.stripeSubscriptionId)
        await markBillingSubscriptionPaymentBlocked(tx as WorkerTransaction, organizationId, candidate.stripeSubscriptionId, now)
        blocked += 1
      }
    }, db)
  }
  return blocked
}

/**
 * Evaluates every organization's auto-recharge rule once (§8 task 2) — each org's decision runs in
 * its own `withWorkerOrganization` transaction, so `maybeTriggerAutoRecharge`'s row lock only ever
 * contends with ANOTHER concurrent worker run touching the SAME org, never across different orgs in
 * this same sweep.
 */
async function sweepAutoRecharge(db: PostgresJsDatabase | typeof workerDb, provider: BillingProvider, now: Date): Promise<number> {
  const orgIds = await listWorkerOrganizationIds(db)
  let triggered = 0
  for (const { id: organizationId } of orgIds) {
    await withWorkerOrganization(organizationId, async (tx) => {
      const outcome = await maybeTriggerAutoRecharge(tx as WorkerTransaction, organizationId, { provider, now })
      if (outcome.triggered) triggered += 1
    }, db)
  }
  return triggered
}

/**
 * Sends every decided-but-not-yet-sent pack refund to the provider (§8 task 4) — subscription
 * refund decisions are deliberately skipped here (`processPendingPackRefund` itself no-ops on
 * those; see `refunds.ts`'s top-of-file comment for why that mechanism isn't built yet).
 */
async function sweepPendingRefunds(db: PostgresJsDatabase | typeof workerDb, provider: BillingProvider): Promise<number> {
  const orgIds = await listWorkerOrganizationIds(db)
  let processed = 0
  for (const { id: organizationId } of orgIds) {
    await withWorkerOrganization(organizationId, async (tx) => {
      const refundIds = await listPendingPackRefundIds(tx as WorkerTransaction, organizationId)
      for (const refundId of refundIds) {
        const outcome = await processPendingPackRefund(tx as WorkerTransaction, organizationId, refundId, { provider })
        if (outcome.processed) processed += 1
      }
    }, db)
  }
  return processed
}

export async function runBillingWorker(options: RunBillingWorkerOptions): Promise<WorkerRunSummary> {
  const db = options.db ?? workerDb
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const now = (options.now ?? (() => new Date()))()

  const claimed = await claimPendingEvents(db, batchSize, leaseSeconds, now)
  const eventResults: WebhookEventProcessingResult[] = []
  for (const event of claimed) {
    eventResults.push(await processOneEvent(event, { db, retriever: options.retriever, maxAttempts, now }))
  }

  const expiredGrants = await sweepExpiredCreditGrants(db, now)
  const annualGrantsIssued = await sweepAnnualSubscriptionGrants(db, now)
  const paymentBlocksApplied = await sweepNonPaymentBlocks(db, now)
  const autoRechargeTriggered = await sweepAutoRecharge(db, options.provider, now)
  const refundsProcessed = await sweepPendingRefunds(db, options.provider)

  return {
    claimedEvents: claimed.length,
    processedEvents: eventResults.filter((r) => r.result === 'processed').length,
    deferredEvents: eventResults.filter((r) => r.result === 'deferred').length,
    deadLetteredEvents: eventResults.filter((r) => r.result === 'dead_lettered').length,
    retryScheduledEvents: eventResults.filter((r) => r.result === 'retry_scheduled').length,
    expiredGrants,
    annualGrantsIssued,
    paymentBlocksApplied,
    autoRechargeTriggered,
    refundsProcessed,
    eventResults,
  }
}

export interface ReplayBillingWebhookEventOptions {
  retriever: EventRetriever
  db?: PostgresJsDatabase | typeof workerDb
  now?: () => Date
}

export class ReplayError extends Error {
  constructor(message: string, readonly code: 'not_found') {
    super(message)
    this.name = 'ReplayError'
  }
}

/**
 * Platform-admin-audited single-event replay (spec.md: "audit and replay one normalized event
 * idempotently"). Bypasses the claim/lease mechanism entirely — replay is explicit and immediate,
 * regardless of the row's current status (including an already-`processed` or dead-lettered row) —
 * but is exactly as safe to re-run as any other delivery: `processStripeWebhookEvent`'s own
 * idempotency guarantees (subscription-state.ts's monotonic ordering, credits.ts's idempotency keys)
 * mean replaying an already-applied event is a no-op, never a double effect.
 */
export async function replayBillingWebhookEvent(
  eventRowId: string,
  options: ReplayBillingWebhookEventOptions,
): Promise<WebhookEventProcessingResult> {
  const db = options.db ?? workerDb
  const now = (options.now ?? (() => new Date()))()

  const [row] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, eventRowId)).limit(1)
  if (!row) throw new ReplayError(`No webhook event found with id ${eventRowId}`, 'not_found')

  return processOneEvent(
    { id: row.id, livemode: row.livemode, stripeEventId: row.stripeEventId, attempts: row.attempts },
    { db, retriever: options.retriever, maxAttempts: Number.MAX_SAFE_INTEGER, now },
  )
}
