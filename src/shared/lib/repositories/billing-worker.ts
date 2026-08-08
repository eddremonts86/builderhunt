/**
 * Worker-only, cross-organization billing data access (plans/phase-1/30-stripe-billing-platform/tasks.md §6
 * task 2, "Implement idempotent monotonic event handlers"). A Stripe webhook event carries only
 * Stripe object ids (customer/subscription/checkout-session id) — never our organizationId — so
 * resolving "which organization does this belong to" requires a lookup RLS's
 * `organization_id = current_setting('app.organization_id')` filter cannot satisfy directly
 * (there is no request-scoped organization to set before the lookup that finds it).
 *
 * This mirrors the SAME cross-org loop pattern `repositories/sprints-worker.ts` and
 * `repositories/alerts-worker.ts` already establish (each duplicates its own
 * `listWorkerOrganizationIds`/`withWorkerOrganization` pair rather than sharing one — matching that
 * precedent here): list every organization id via an unscoped read of the (non-tenant-private)
 * `organizations` table, then check each one's billing rows one at a time inside a transaction
 * scoped to exactly that organization via `set_config('app.organization_id', ...)`. This is
 * O(organizations) per event — acceptable at this app's current scale; if organization count grows
 * enough to matter, the fix is a dedicated cross-org lookup index/materialized view, not a change to
 * this file's contract.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { billingAutoRechargeRules, billingCheckoutAttempts, billingCreditGrants, billingCustomers, billingDisputes, billingRefunds, billingSubscriptions, organizations } from '../db/schema'
import { WORKER_ORGANIZATION_BATCH } from './worker-organization-scan'
import { collectWorkerOrganizationIds } from './worker-organization-scan'

/**
 * `db` defaults to the real `workerDb` singleton in production; tests inject a disposable database
 * bound to a fresh `PostgresJsDatabase` instead — the same dependency-injection pattern used
 * throughout this plan's other billing modules (`seller-profile.ts`, `checkout.ts`'s
 * `sellerProfileDb`) rather than the older `sprints-worker.ts`/`alerts-worker.ts` precedent of
 * hardcoding `workerDb` with no override. This code moves real money — worth the extra parameter to
 * get real integration-test coverage on the cross-org lookup and the writes it protects.
 */
/**
 * One batch of organization ids, ascending — bounded since plan 12.
 *
 * Callers must **drain** this, not take the first batch: a worker that silently skips the
 * five-hundred-and-first organization has not failed, it has just not done the work, and nobody is
 * waiting on that tenant to notice. `collectWorkerOrganizationIds`/`drainWorkerOrganizations` in
 * `worker-organization-scan.ts` are the shapes that cannot get the termination condition wrong.
 */
export function listWorkerOrganizationIds(
  db: PostgresJsDatabase | typeof workerDb = workerDb,
  after: string | null = null,
  limit: number = WORKER_ORGANIZATION_BATCH,
) {
  return db.select({ id: organizations.id }).from(organizations)
    .where(after ? gt(organizations.id, after) : undefined)
    .orderBy(asc(organizations.id))
    .limit(limit)
}

export function withWorkerOrganization<TResult>(
  organizationId: string,
  operation: (transaction: WorkerTransaction) => Promise<TResult>,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`
      select
        set_config('app.organization_id', ${organizationId}, true),
        set_config('app.organization_role', 'worker', true),
        set_config('app.request_id', ${crypto.randomUUID()}, true)
    `)
    return operation(transaction as WorkerTransaction)
  })
}

async function findOwningOrganizationId(
  check: (transaction: WorkerTransaction, organizationId: string) => Promise<boolean>,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<string | null> {
  // Drained rather than one batch: `listWorkerOrganizationIds` is bounded (plan 12), and a worker
  // that stops at the batch size has silently skipped every organization past it.
  const orgIds = (await collectWorkerOrganizationIds((after, limit) => listWorkerOrganizationIds(db, after, limit))).map((id) => ({ id }))
  for (const { id: organizationId } of orgIds) {
    const found = await withWorkerOrganization(organizationId, (tx) => check(tx, organizationId), db)
    if (found) return organizationId
  }
  return null
}

export function findOrganizationIdForStripeSubscription(
  stripeSubscriptionId: string,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<string | null> {
  return findOwningOrganizationId(async (tx, organizationId) => {
    const [row] = await tx.select({ id: billingSubscriptions.id }).from(billingSubscriptions)
      .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId)))
      .limit(1)
    return Boolean(row)
  }, db)
}

export function findOrganizationIdForStripeCustomer(
  stripeCustomerId: string,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<string | null> {
  return findOwningOrganizationId(async (tx, organizationId) => {
    const [row] = await tx.select({ id: billingCustomers.id }).from(billingCustomers)
      .where(and(eq(billingCustomers.organizationId, organizationId), eq(billingCustomers.stripeCustomerId, stripeCustomerId)))
      .limit(1)
    return Boolean(row)
  }, db)
}

export function findOrganizationIdForStripeCheckoutSession(
  stripeCheckoutSessionId: string,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<string | null> {
  return findOwningOrganizationId(async (tx, organizationId) => {
    const [row] = await tx.select({ id: billingCheckoutAttempts.id }).from(billingCheckoutAttempts)
      .where(and(eq(billingCheckoutAttempts.organizationId, organizationId), eq(billingCheckoutAttempts.stripeCheckoutSessionId, stripeCheckoutSessionId)))
      .limit(1)
    return Boolean(row)
  }, db)
}

/** Resolves which organization a `payment_intent.*` event belongs to when it was created for auto-recharge (§8 task 2) — the ONLY cross-org signal for a bare PaymentIntent event, since (unlike Checkout Sessions) it never goes through `billing_checkout_attempts`. Only matches while the charge is still marked in-flight (`pending_payment_intent_id`); once resolved this stops matching, exactly like `findBillingCheckoutAttemptByStripeSessionId`'s own attempt-row lookup stops mattering once its status leaves `open`. */
export function findOrganizationIdForPendingAutoRechargePaymentIntent(
  paymentIntentId: string,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<string | null> {
  return findOwningOrganizationId(async (tx, organizationId) => {
    const [row] = await tx.select({ id: billingAutoRechargeRules.organizationId }).from(billingAutoRechargeRules)
      .where(and(eq(billingAutoRechargeRules.organizationId, organizationId), eq(billingAutoRechargeRules.pendingPaymentIntentId, paymentIntentId)))
      .limit(1)
    return Boolean(row)
  }, db)
}

/** Resolves which organization a `refund.*`/`charge.refunded` event belongs to (§8 task 4) — the only cross-org signal for a bare refund event is the `stripe_refund_id` this app itself set on `billing_refunds` when it sent the refund to the provider (`markBillingRefundProviderRefund`). */
export function findOrganizationIdForStripeRefund(
  stripeRefundId: string,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<string | null> {
  return findOwningOrganizationId(async (tx, organizationId) => {
    const [row] = await tx.select({ id: billingRefunds.id }).from(billingRefunds)
      .where(and(eq(billingRefunds.organizationId, organizationId), eq(billingRefunds.stripeRefundId, stripeRefundId)))
      .limit(1)
    return Boolean(row)
  }, db)
}

/** Resolves which organization a `charge.dispute.created` event belongs to (§8 task 5) — the only signal available at creation time is the disputed PaymentIntent, matched against `billing_credit_grants.stripe_payment_intent_id` (the same column §8 task 4's refunds already populate for every pack grant). Subscription disputes are out of scope — see `billing/disputes.ts`'s module comment. */
export function findOrganizationIdForDisputedPaymentIntent(
  stripePaymentIntentId: string,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<string | null> {
  return findOwningOrganizationId(async (tx, organizationId) => {
    const [row] = await tx.select({ id: billingCreditGrants.id }).from(billingCreditGrants)
      .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.stripePaymentIntentId, stripePaymentIntentId)))
      .limit(1)
    return Boolean(row)
  }, db)
}

/** Resolves which organization a `charge.dispute.updated`/`charge.dispute.closed`/`charge.dispute.funds_reinstated` event belongs to — keyed on OUR OWN `stripe_dispute_id`, set the moment `charge.dispute.created` first recorded it. */
export function findOrganizationIdForStripeDispute(
  stripeDisputeId: string,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<string | null> {
  return findOwningOrganizationId(async (tx, organizationId) => {
    const [row] = await tx.select({ id: billingDisputes.id }).from(billingDisputes)
      .where(and(eq(billingDisputes.organizationId, organizationId), eq(billingDisputes.stripeDisputeId, stripeDisputeId)))
      .limit(1)
    return Boolean(row)
  }, db)
}

export interface FullBillingSubscriptionRecord {
  id: string
  organizationId: string
  customerId: string
  livemode: boolean
  catalogKey: string
  tier: string
  interval: string
  catalogVersion: number
  stripeSubscriptionId: string
  stripeStatus: string
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  scheduledChange: { catalogKey: string; effectiveAt: string } | null
  gracePeriodEndsAt: Date | null
  paymentBlockedAt: Date | null
  cancelAtPeriodEnd: boolean
  canceledAt: Date | null
  providerSyncedAt: Date
}

/** Every column a webhook handler needs to make a monotonic-ordering decision — `repositories/billing.ts`'s own `findActiveBillingSubscription` deliberately omits most of these for its own (read-summary) purposes. */
export async function findFullBillingSubscriptionByStripeId(
  transaction: WorkerTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
): Promise<FullBillingSubscriptionRecord | null> {
  const [row] = await transaction
    .select({
      id: billingSubscriptions.id,
      organizationId: billingSubscriptions.organizationId,
      customerId: billingSubscriptions.customerId,
      livemode: billingSubscriptions.livemode,
      catalogKey: billingSubscriptions.catalogKey,
      tier: billingSubscriptions.tier,
      interval: billingSubscriptions.interval,
      catalogVersion: billingSubscriptions.catalogVersion,
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
      stripeStatus: billingSubscriptions.stripeStatus,
      currentPeriodStart: billingSubscriptions.currentPeriodStart,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      scheduledChange: billingSubscriptions.scheduledChange,
      gracePeriodEndsAt: billingSubscriptions.gracePeriodEndsAt,
      paymentBlockedAt: billingSubscriptions.paymentBlockedAt,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
      canceledAt: billingSubscriptions.canceledAt,
      providerSyncedAt: billingSubscriptions.providerSyncedAt,
    })
    .from(billingSubscriptions)
    .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId)))
    .limit(1)
  return row ?? null
}

export interface ActiveAnnualBillingSubscriptionRecord {
  stripeSubscriptionId: string
  catalogKey: string
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
}

/** Annual subscriptions in good standing (`active`/`trialing`) for the sweep that issues the remaining 11 monthly credit windows (plans/phase-1/30-stripe-billing-platform/tasks.md §7 "Issue annual subscription credits monthly") — stops naturally once a subscription lapses into any other status. */
export async function listActiveAnnualBillingSubscriptions(
  transaction: WorkerTransaction,
  organizationId: string,
): Promise<ActiveAnnualBillingSubscriptionRecord[]> {
  return transaction
    .select({
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
      catalogKey: billingSubscriptions.catalogKey,
      currentPeriodStart: billingSubscriptions.currentPeriodStart,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
    })
    .from(billingSubscriptions)
    .where(and(
      eq(billingSubscriptions.organizationId, organizationId),
      eq(billingSubscriptions.interval, 'annual'),
      sql`${billingSubscriptions.stripeStatus} in ('active', 'trialing')`,
    ))
}

export interface GracePeriodBillingSubscriptionRecord {
  stripeSubscriptionId: string
  gracePeriodEndsAt: Date | null
  paymentBlockedAt: Date | null
}

/** Every subscription currently in a grace period (payment-failure marker set) and not yet blocked — what the daily dunning sweep (plans/phase-1/30-stripe-billing-platform/tasks.md §7 "Implement seven-day dunning and recovery") checks against `dunning.ts`'s `shouldBlockForNonPayment`. Already-blocked subscriptions are excluded here (not merely re-checked and no-op'd) so the sweep's own row count reflects real work, not repeats. */
export async function listGracePeriodBillingSubscriptions(
  transaction: WorkerTransaction,
  organizationId: string,
): Promise<GracePeriodBillingSubscriptionRecord[]> {
  return transaction
    .select({
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
      gracePeriodEndsAt: billingSubscriptions.gracePeriodEndsAt,
      paymentBlockedAt: billingSubscriptions.paymentBlockedAt,
    })
    .from(billingSubscriptions)
    .where(and(
      eq(billingSubscriptions.organizationId, organizationId),
      sql`${billingSubscriptions.gracePeriodEndsAt} is not null`,
      sql`${billingSubscriptions.paymentBlockedAt} is null`,
    ))
}

export interface UpdateBillingSubscriptionFromStripeInput {
  stripeStatus: string
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  canceledAt: Date | null
  providerSyncedAt: Date
}

/** Always writes `providerSyncedAt` — callers must have already confirmed the incoming event is monotonically newer than the row's current value before calling this (subscription-state.ts's job, not this repository's). */
export async function updateBillingSubscriptionFromStripe(
  transaction: WorkerTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
  input: UpdateBillingSubscriptionFromStripeInput,
): Promise<void> {
  await transaction
    .update(billingSubscriptions)
    .set(input)
    .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId)))
}

/**
 * Records the first-failure timestamp exactly once (an already-set `gracePeriodEndsAt` is left
 * untouched) — the seven-day grace/block worker (plans/phase-1/30-stripe-billing-platform/tasks.md §7
 * "Implement seven-day dunning and recovery") owns acting on it. Returns whether THIS call actually
 * started the grace period (`true`) versus a no-op because one was already in progress (`false`) —
 * §9 task 4's payment-failed notification email uses this to send exactly once per grace window,
 * never on a duplicate/retried webhook delivery.
 */
export async function markBillingSubscriptionGraceStart(
  transaction: WorkerTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
  gracePeriodEndsAt: Date,
): Promise<boolean> {
  const rows = await transaction
    .update(billingSubscriptions)
    .set({ gracePeriodEndsAt })
    .where(and(
      eq(billingSubscriptions.organizationId, organizationId),
      eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId),
      sql`${billingSubscriptions.gracePeriodEndsAt} is null`,
    ))
    .returning({ id: billingSubscriptions.id })
  return rows.length > 0
}

/** Clears a grace-period marker once payment recovers before the worker ever acted on it. */
export async function clearBillingSubscriptionGrace(
  transaction: WorkerTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
): Promise<void> {
  await transaction
    .update(billingSubscriptions)
    .set({ gracePeriodEndsAt: null })
    .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId)))
}

/** Records the block timestamp exactly once (an already-blocked row is left untouched) — `dunning.ts`'s worker sweep owns deciding WHEN to call this; this repository function only ever records the decision. */
export async function markBillingSubscriptionPaymentBlocked(
  transaction: WorkerTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
  paymentBlockedAt: Date,
): Promise<void> {
  await transaction
    .update(billingSubscriptions)
    .set({ paymentBlockedAt })
    .where(and(
      eq(billingSubscriptions.organizationId, organizationId),
      eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId),
      sql`${billingSubscriptions.paymentBlockedAt} is null`,
    ))
}

/** Clears both the block and any lingering grace marker on recovery — a recovered subscription is no longer "in grace" either, it's simply current. */
export async function clearBillingSubscriptionPaymentBlock(
  transaction: WorkerTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
): Promise<void> {
  await transaction
    .update(billingSubscriptions)
    .set({ paymentBlockedAt: null, gracePeriodEndsAt: null })
    .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId)))
}

export async function findBillingCheckoutAttemptByStripeSessionId(
  transaction: WorkerTransaction,
  organizationId: string,
  stripeCheckoutSessionId: string,
) {
  const [row] = await transaction
    .select({
      id: billingCheckoutAttempts.id,
      status: billingCheckoutAttempts.status,
      action: billingCheckoutAttempts.action,
      catalogKey: billingCheckoutAttempts.catalogKey,
    })
    .from(billingCheckoutAttempts)
    .where(and(eq(billingCheckoutAttempts.organizationId, organizationId), eq(billingCheckoutAttempts.stripeCheckoutSessionId, stripeCheckoutSessionId)))
    .limit(1)
  return row ?? null
}

/** No-op if the attempt is already in a terminal state (`complete`/`expired`/`canceled`) — a duplicate or out-of-order delivery of the same Checkout event must never regress it. */
export async function updateBillingCheckoutAttemptStatus(
  transaction: WorkerTransaction,
  organizationId: string,
  stripeCheckoutSessionId: string,
  status: 'complete' | 'expired' | 'canceled',
): Promise<void> {
  await transaction
    .update(billingCheckoutAttempts)
    .set({ status })
    .where(and(
      eq(billingCheckoutAttempts.organizationId, organizationId),
      eq(billingCheckoutAttempts.stripeCheckoutSessionId, stripeCheckoutSessionId),
      sql`${billingCheckoutAttempts.status} = 'open'`,
    ))
}
