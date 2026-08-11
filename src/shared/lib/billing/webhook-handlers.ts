/**
 * Idempotent, monotonic Stripe webhook event handlers (plans/implemented/30-stripe-billing-platform/tasks.md §6
 * "Implement idempotent monotonic event handlers"; spec.md §Webhook and consistency contract).
 * `webhook-inbox.ts` (§6 task 1) already verified the signature and durably stored the event before
 * this module is ever called — everything here is about APPLYING one already-trusted event, safely,
 * regardless of delivery order or repetition.
 *
 * Every handler is idempotent by construction: subscription/period effects go through
 * `subscription-state.ts`'s `resolveSubscriptionTransition` (never regresses on a stale/duplicate
 * event), and credit grants go through `credits.ts`'s `grantCredits` (idempotent by a stable
 * business key derived from the Stripe object id, not the delivery-specific event id — so the SAME
 * invoice granting credits via two different webhook deliveries still converges on one grant).
 *
 * Required families (spec.md): Checkout completed/expired; invoice paid/payment failed;
 * subscription created/updated/deleted; PaymentIntent succeeded/failed/action required; refund
 * created/updated/failed; and dispute created/updated/closed/funds reinstated. The first four
 * families are fully actionable today (customers/checkout/credits/subscriptions/packs/auto-recharge
 * all exist — see `handlePackCheckoutCompleted` and `handleAutoRechargePaymentIntentEvent`). Refund
 * and dispute events still have nothing to reconcile against — refund review (§8 task 4) and dispute
 * handling (§8 task 5) are later, dedicated tasks — so those events are recorded as `'deferred'`, a
 * distinct, honest outcome from `'ignored'` (a genuinely unrecognized event type): "deferred" means
 * the worker (§6 task 3) should leave the row pending and revisit it once that later infrastructure
 * exists, never that nothing needs to happen.
 *
 * Webhook events reference Stripe object ids (customer/subscription/checkout-session), never our
 * organizationId — resolving "which organization does this belong to" needs the cross-org lookup
 * `repositories/billing-worker.ts` documents and provides.
 */
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type Stripe from 'stripe'
import { computeAnniversary } from './annual-grants'
import { resolvePackCatalogEntryByKey, resolveSubscriptionCatalogEntryByKey, resolveSubscriptionCatalogEntryByStripePriceId } from './catalog'
import { grantCredits } from './credits'
import { recordDisputeFundsReinstated, recordDisputeOpened, resolveDispute, updateDisputeStripeStatus } from './disputes'
import { unfreezeStillValidGrantsOnRecovery } from './dunning'
import { endOverlappingManualAuthority } from './legacy-migration'
import { billingNotificationRecipients } from './notifications'
import { applyCreditRevocationForRefund } from './refunds'
import { sendBillingPaymentFailedEmail, sendBillingReceiptEmail } from '../email'
import {
  findAutoRechargeRule,
  findBillingCustomer,
  findBillingRefundByStripeRefundId,
  resolveAutoRechargeTrigger,
  updateBillingRefundState,
} from '../repositories/billing'
import { findCreditGrant, findCreditGrantByStripePaymentIntentId } from '../repositories/billing-ledger'
import {
  clearBillingSubscriptionPaymentBlock,
  findBillingCheckoutAttemptByStripeSessionId,
  findFullBillingSubscriptionByStripeId,
  findOrganizationIdForDisputedPaymentIntent,
  findOrganizationIdForPendingAutoRechargePaymentIntent,
  findOrganizationIdForStripeCheckoutSession,
  findOrganizationIdForStripeCustomer,
  findOrganizationIdForStripeDispute,
  findOrganizationIdForStripeRefund,
  findOrganizationIdForStripeSubscription,
  markBillingSubscriptionGraceStart,
  updateBillingCheckoutAttemptStatus,
  updateBillingSubscriptionFromStripe,
  withWorkerOrganization,
} from '../repositories/billing-worker'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { billingSubscriptions } from '../db/schema'
import { resolveSubscriptionTransition } from './subscription-state'
import { projectSubscriptionEntitlement } from './subscriptions'

export type WebhookHandlerOutcome =
  | { outcome: 'applied'; detail: string }
  | { outcome: 'ignored'; detail: string }
  | { outcome: 'deferred'; detail: string }

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

function toDate(unixSeconds: number | null | undefined): Date | null {
  return unixSeconds ? new Date(unixSeconds * 1000) : null
}

function extractId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

export interface ProcessStripeWebhookEventOptions {
  /** Overrides `resolveSubscriptionCatalogEntryByStripePriceId`'s livemode argument — defaults to the event's own `livemode` flag (already verified against the deployment's expected mode by `webhook-inbox.ts`). */
  livemode?: boolean
  /** Defaults to the real `workerDb` singleton — tests inject a disposable database. See `repositories/billing-worker.ts`'s module doc. */
  db?: PostgresJsDatabase | typeof workerDb
  /** Test-only override for `findOrganizationOwnerEmail`'s auth-broker read (via `billingNotificationRecipients`, invoice.paid/payment_failed receipts) — defaults to the real `authDb`. */
  authDb?: PostgresJsDatabase
}

export async function processStripeWebhookEvent(
  event: Stripe.Event,
  options: ProcessStripeWebhookEventOptions = {},
): Promise<WebhookHandlerOutcome> {
  const livemode = options.livemode ?? event.livemode
  const db = options.db ?? workerDb

  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutSessionStatus(event.data.object as Stripe.Checkout.Session, 'complete', db, new Date(event.created * 1000))
    case 'checkout.session.expired':
      return handleCheckoutSessionStatus(event.data.object as Stripe.Checkout.Session, 'expired', db, new Date(event.created * 1000))

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return handleSubscriptionUpsert(event, livemode, db)
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event, db)

    case 'invoice.paid':
      return handleInvoicePaid(event, db, options.authDb)
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(event, db, options.authDb)

    case 'payment_intent.succeeded':
      return handleAutoRechargePaymentIntentEvent(event, 'succeeded', db)
    case 'payment_intent.payment_failed':
      return handleAutoRechargePaymentIntentEvent(event, 'payment_failed', db)
    case 'payment_intent.requires_action':
      return handleAutoRechargePaymentIntentEvent(event, 'requires_action', db)

    case 'refund.updated':
    case 'refund.failed':
      return handleRefundStatusEvent(event, db)
    case 'refund.created':
    case 'charge.refunded':
      // Informational only — this app already records the refund synchronously the moment it sends
      // it to the provider (`markBillingRefundProviderRefund` in `refunds.ts`'s
      // `processPendingPackRefund`). `refund.updated`/`refund.failed` carry the actionable status
      // transition; these two events add nothing our own state doesn't already have.
      return { outcome: 'ignored', detail: `${event.type}: informational only, no actionable state beyond what refund.updated/refund.failed already carry` }

    case 'charge.dispute.created':
      return handleDisputeCreated(event, db)
    case 'charge.dispute.updated':
      return handleDisputeUpdated(event, db)
    case 'charge.dispute.closed':
      return handleDisputeClosed(event, db)
    case 'charge.dispute.funds_reinstated':
      return handleDisputeFundsReinstated(event, db)

    default:
      return { outcome: 'ignored', detail: `Unrecognized event type: ${event.type}` }
  }
}

async function handleCheckoutSessionStatus(
  session: Stripe.Checkout.Session,
  status: 'complete' | 'expired',
  db: PostgresJsDatabase | typeof workerDb,
  eventTimestamp: Date,
): Promise<WebhookHandlerOutcome> {
  const organizationId = await findOrganizationIdForStripeCheckoutSession(session.id, db)
  if (!organizationId) {
    return { outcome: 'deferred', detail: `No checkout attempt found yet for session ${session.id}` }
  }

  return withWorkerOrganization(organizationId, async (tx) => {
    const attempt = await findBillingCheckoutAttemptByStripeSessionId(tx, organizationId, session.id)
    if (!attempt) return { outcome: 'deferred', detail: `Checkout attempt row not found inside org scope for session ${session.id}` }
    if (attempt.status !== 'open') {
      return { outcome: 'applied', detail: `Checkout attempt ${attempt.id} already ${attempt.status} — duplicate delivery, no-op` }
    }

    await updateBillingCheckoutAttemptStatus(tx, organizationId, session.id, status)

    // Packs (action: 'credits', mode: 'payment') grant credits right here, on completion — there is
    // no subsequent invoice for a one-shot payment-mode Checkout the way subscriptions have
    // `invoice.paid`. See this file's top-of-file comment and `handlePackCheckoutCompleted` below.
    if (attempt.action === 'credits' && session.mode === 'payment' && status === 'complete') {
      return handlePackCheckoutCompleted(tx, organizationId, attempt, session.id, extractId(session.payment_intent), eventTimestamp)
    }

    return { outcome: 'applied', detail: `Checkout attempt ${attempt.id} marked ${status}` }
  }, db)
}

/**
 * Grants the exact catalog units for a completed pack purchase (spec.md: "grant exact units for 12
 * months only on success webhook"). Idempotent via `grantCredits`' own idempotency key, keyed off
 * this Checkout Session id — a duplicate `checkout.session.completed` delivery (or one arriving
 * after the attempt was already marked `complete` by a prior delivery, caught above) never grants
 * twice. Expiry is computed from the event's own timestamp, not "now" (worker clock), so a delayed
 * replay still expires exactly 12 months after the actual purchase.
 */
async function handlePackCheckoutCompleted(
  tx: WorkerTransaction,
  organizationId: string,
  attempt: { id: string; catalogKey: string },
  stripeCheckoutSessionId: string,
  stripePaymentIntentId: string | null,
  eventTimestamp: Date,
): Promise<WebhookHandlerOutcome> {
  const catalogEntry = resolvePackCatalogEntryByKey(attempt.catalogKey)
  if (!catalogEntry) {
    return { outcome: 'ignored', detail: `Pack catalog key ${attempt.catalogKey} no longer resolves` }
  }

  const result = await grantCredits(tx, {
    grantId: randomUUID(),
    ledgerEntryId: randomUUID(),
    organizationId,
    source: 'pack',
    sourceReference: catalogEntry.key,
    stripePaymentReference: stripeCheckoutSessionId,
    stripePaymentIntentId: stripePaymentIntentId ?? undefined,
    units: catalogEntry.credits,
    expiresAt: computeAnniversary(eventTimestamp, catalogEntry.expiryMonths),
    idempotencyKey: `pack-grant:${stripeCheckoutSessionId}`,
  })
  return {
    outcome: 'applied',
    detail: result.replayed
      ? `Checkout session ${stripeCheckoutSessionId} already granted pack credits — duplicate delivery, no-op`
      : `Granted ${catalogEntry.credits} pack credits for checkout attempt ${attempt.id}`,
  }
}

/**
 * Resolves the outcome of an off-session auto-recharge charge (§8 task 2). Unlike a Checkout
 * Session, a bare PaymentIntent carries no Checkout attempt row to key off of — the only cross-org
 * signal is `billing_auto_recharge_rules.pending_payment_intent_id`
 * (`findOrganizationIdForPendingAutoRechargePaymentIntent`), set the moment
 * `auto-recharge.ts`'s `maybeTriggerAutoRecharge` creates the charge. A PaymentIntent event whose org
 * can no longer be found this way (already resolved by an earlier delivery of the SAME event, or
 * never ours) stays `'deferred'` rather than `'ignored'` — safe (no double-grant, no double-charge:
 * `resolveAutoRechargeTrigger`'s own `pendingPaymentIntentId` match guards that), if not perfectly
 * tidy in the webhook-inbox row's own bookkeeping for an already-resolved duplicate.
 */
async function handleAutoRechargePaymentIntentEvent(
  event: Stripe.Event,
  outcome: 'succeeded' | 'payment_failed' | 'requires_action',
  db: PostgresJsDatabase | typeof workerDb,
): Promise<WebhookHandlerOutcome> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent
  const eventTimestamp = new Date(event.created * 1000)

  const organizationId = await findOrganizationIdForPendingAutoRechargePaymentIntent(paymentIntent.id, db)
  if (!organizationId) {
    return { outcome: 'deferred', detail: `No auto-recharge rule has a pending charge for PaymentIntent ${paymentIntent.id} (not ours, or already resolved)` }
  }

  return withWorkerOrganization(organizationId, async (tx) => {
    const rule = await findAutoRechargeRule(tx, organizationId)
    if (!rule || rule.pendingPaymentIntentId !== paymentIntent.id) {
      return { outcome: 'applied', detail: `Auto-recharge trigger for PaymentIntent ${paymentIntent.id} already resolved — duplicate delivery, no-op` }
    }

    if (outcome === 'succeeded') {
      const catalogEntry = rule.packCatalogKey ? resolvePackCatalogEntryByKey(rule.packCatalogKey) : null
      if (catalogEntry) {
        await grantCredits(tx, {
          grantId: randomUUID(),
          ledgerEntryId: randomUUID(),
          organizationId,
          source: 'pack',
          sourceReference: catalogEntry.key,
          stripePaymentReference: paymentIntent.id,
          stripePaymentIntentId: paymentIntent.id,
          units: catalogEntry.credits,
          expiresAt: computeAnniversary(eventTimestamp, catalogEntry.expiryMonths),
          idempotencyKey: `auto-recharge-grant:${paymentIntent.id}`,
        })
      }
      await resolveAutoRechargeTrigger(tx, organizationId, paymentIntent.id, { state: 'active' })
      return { outcome: 'applied', detail: `Auto-recharge charge ${paymentIntent.id} succeeded — credits granted, rule reactivated` }
    }

    if (outcome === 'requires_action') {
      await resolveAutoRechargeTrigger(tx, organizationId, paymentIntent.id, {
        state: 'paused_needs_auth',
        lastFailureAt: eventTimestamp,
        lastFailureReason: 'Additional authentication required for this off-session charge',
      })
      return { outcome: 'applied', detail: `Auto-recharge charge ${paymentIntent.id} requires authentication — paused` }
    }

    await resolveAutoRechargeTrigger(tx, organizationId, paymentIntent.id, {
      state: 'paused_failed',
      lastFailureAt: eventTimestamp,
      lastFailureReason: 'Off-session payment failed',
    })
    return { outcome: 'applied', detail: `Auto-recharge charge ${paymentIntent.id} failed — paused` }
  }, db)
}

/**
 * Resolves the async outcome of a refund this app already sent to the provider (§8 task 4,
 * `refunds.ts`'s `processPendingPackRefund`) — the only cross-org signal is the
 * `stripe_refund_id` this app itself set when sending it. A refund whose provider status came back
 * `succeeded` synchronously already had its credit revocation applied at send time; this handler
 * exists for the case where it did not (a real refund is often `pending` before settling), and for
 * `refund.failed`.
 */
async function handleRefundStatusEvent(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb): Promise<WebhookHandlerOutcome> {
  const stripeRefund = event.data.object as Stripe.Refund
  const organizationId = await findOrganizationIdForStripeRefund(stripeRefund.id, db)
  if (!organizationId) {
    return { outcome: 'deferred', detail: `No refund record found yet for Stripe refund ${stripeRefund.id}` }
  }

  return withWorkerOrganization(organizationId, async (tx) => {
    const refund = await findBillingRefundByStripeRefundId(tx, organizationId, stripeRefund.id)
    if (!refund) return { outcome: 'deferred', detail: `Refund row not found inside org scope for ${stripeRefund.id}` }
    if (refund.state === 'succeeded' || refund.state === 'failed') {
      return { outcome: 'applied', detail: `Refund ${refund.id} already ${refund.state} — duplicate delivery, no-op` }
    }

    if (stripeRefund.status === 'succeeded') {
      await updateBillingRefundState(tx, organizationId, refund.id, 'succeeded')
      if (refund.grantId) {
        const grant = await findCreditGrant(tx, organizationId, refund.grantId)
        if (grant) await applyCreditRevocationForRefund(tx, organizationId, refund, grant)
      }
      return { outcome: 'applied', detail: `Refund ${refund.id} succeeded — credits revoked` }
    }
    if (stripeRefund.status === 'failed' || stripeRefund.status === 'canceled') {
      await updateBillingRefundState(tx, organizationId, refund.id, 'failed')
      return { outcome: 'applied', detail: `Refund ${refund.id} marked failed` }
    }
    return { outcome: 'applied', detail: `Refund ${refund.id} still ${stripeRefund.status} — awaiting resolution` }
  }, db)
}

/**
 * `charge.dispute.created` (§8 task 5) — resolves the organization via the disputed PaymentIntent
 * against `billing_credit_grants.stripe_payment_intent_id` (only ever populated for pack/
 * auto-recharge grants — see `disputes.ts`'s module comment for why a subscription-invoice dispute
 * stays `'deferred'` here rather than silently dropped).
 */
async function handleDisputeCreated(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb): Promise<WebhookHandlerOutcome> {
  const dispute = event.data.object as Stripe.Dispute
  const stripePaymentIntentId = extractId(dispute.payment_intent)
  if (!stripePaymentIntentId) return { outcome: 'ignored', detail: `Dispute ${dispute.id} has no PaymentIntent` }

  const organizationId = await findOrganizationIdForDisputedPaymentIntent(stripePaymentIntentId, db)
  if (!organizationId) {
    return { outcome: 'deferred', detail: `No pack grant found yet for disputed PaymentIntent ${stripePaymentIntentId} (not ours, a subscription dispute out of this task's scope, or not yet observed)` }
  }

  return withWorkerOrganization(organizationId, async (tx) => {
    const grant = await findCreditGrantByStripePaymentIntentId(tx, organizationId, stripePaymentIntentId)
    const result = await recordDisputeOpened(tx, {
      organizationId,
      grantId: grant?.id ?? null,
      stripeDisputeId: dispute.id,
      stripePaymentIntentId,
      amountCents: dispute.amount,
      reason: dispute.reason ?? null,
      stripeStatus: dispute.status,
      evidenceDueBy: toDate(dispute.evidence_details?.due_by),
    })
    return { outcome: 'applied', detail: `Dispute ${result.stripeDisputeId} recorded${grant ? ` — grant ${grant.id} frozen` : ' (no linked grant)'}` }
  }, db)
}

/** `charge.dispute.updated` — status/evidence-deadline sync only, never an outcome transition. */
async function handleDisputeUpdated(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb): Promise<WebhookHandlerOutcome> {
  const dispute = event.data.object as Stripe.Dispute
  const organizationId = await findOrganizationIdForStripeDispute(dispute.id, db)
  if (!organizationId) return { outcome: 'deferred', detail: `No dispute record found yet for ${dispute.id}` }

  return withWorkerOrganization(organizationId, async (tx) => {
    const updated = await updateDisputeStripeStatus(tx, organizationId, dispute.id, dispute.status, toDate(dispute.evidence_details?.due_by))
    if (!updated) return { outcome: 'deferred', detail: `Dispute row not found inside org scope for ${dispute.id}` }
    return { outcome: 'applied', detail: `Dispute ${dispute.id} status synced to ${dispute.status}` }
  }, db)
}

/** `charge.dispute.closed` — the only path that ever changes `outcome` (won/lost), restoring or revoking the linked grant accordingly. */
async function handleDisputeClosed(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb): Promise<WebhookHandlerOutcome> {
  const dispute = event.data.object as Stripe.Dispute
  const organizationId = await findOrganizationIdForStripeDispute(dispute.id, db)
  if (!organizationId) return { outcome: 'deferred', detail: `No dispute record found yet for ${dispute.id}` }

  // Stripe's dispute.status at 'closed' time is one of 'won'/'lost' (also 'warning_closed' for an
  // early-stage warning that closes without a formal outcome — treated as 'lost' defensively: never
  // silently restore access on an ambiguous closure).
  const outcome = dispute.status === 'won' ? 'won' : 'lost'

  return withWorkerOrganization(organizationId, async (tx) => {
    const resolved = await resolveDispute(tx, organizationId, { stripeDisputeId: dispute.id, outcome, stripeStatus: dispute.status })
    if (!resolved) return { outcome: 'deferred', detail: `Dispute row not found inside org scope for ${dispute.id}` }
    return { outcome: 'applied', detail: `Dispute ${dispute.id} closed as ${outcome}` }
  }, db)
}

/** `charge.dispute.funds_reinstated` — see `disputes.ts`'s module comment for why this only records an accounting fact, never reverses a lost dispute's credit revocation. */
async function handleDisputeFundsReinstated(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb): Promise<WebhookHandlerOutcome> {
  const dispute = event.data.object as Stripe.Dispute
  const organizationId = await findOrganizationIdForStripeDispute(dispute.id, db)
  if (!organizationId) return { outcome: 'deferred', detail: `No dispute record found yet for ${dispute.id}` }

  return withWorkerOrganization(organizationId, async (tx) => {
    const updated = await recordDisputeFundsReinstated(tx, organizationId, dispute.id, new Date(event.created * 1000))
    if (!updated) return { outcome: 'deferred', detail: `Dispute row not found inside org scope for ${dispute.id}` }
    return { outcome: 'applied', detail: `Dispute ${dispute.id} funds reinstated recorded` }
  }, db)
}

async function handleSubscriptionUpsert(
  event: Stripe.Event,
  livemode: boolean,
  db: PostgresJsDatabase | typeof workerDb,
): Promise<WebhookHandlerOutcome> {
  const subscription = event.data.object as Stripe.Subscription
  const eventTimestamp = new Date(event.created * 1000)
  const item = subscription.items.data[0]
  if (!item) return { outcome: 'ignored', detail: `Subscription ${subscription.id} has no items` }

  const stripeCustomerId = extractId(subscription.customer)
  if (!stripeCustomerId) return { outcome: 'ignored', detail: `Subscription ${subscription.id} has no customer` }

  let organizationId = await findOrganizationIdForStripeSubscription(subscription.id, db)
  const isNewSubscriptionRecord = !organizationId
  if (!organizationId) {
    organizationId = await findOrganizationIdForStripeCustomer(stripeCustomerId, db)
  }
  if (!organizationId) {
    return { outcome: 'deferred', detail: `No organization found yet for customer ${stripeCustomerId} (Checkout not yet processed)` }
  }

  return withWorkerOrganization(organizationId, async (tx) => {
    const existing = await findFullBillingSubscriptionByStripeId(tx, organizationId, subscription.id)

    const decision = resolveSubscriptionTransition(
      existing ? { status: existing.stripeStatus, providerSyncedAt: existing.providerSyncedAt } : null,
      { status: subscription.status, eventTimestamp },
    )
    if (!decision.apply) {
      return { outcome: 'ignored', detail: `Subscription ${subscription.id} transition rejected: ${decision.reason}` }
    }

    if (!existing) {
      const catalogEntry = resolveSubscriptionCatalogEntryByStripePriceId(item.price.id, livemode)
      if (!catalogEntry) {
        return { outcome: 'ignored', detail: `Price ${item.price.id} does not match any catalog entry` }
      }
      const customer = await findBillingCustomer(tx, organizationId, livemode)
      if (!customer) {
        return { outcome: 'deferred', detail: `No billing customer row found yet for organization ${organizationId}` }
      }

      await tx.insert(billingSubscriptions).values({
        id: randomUUID(),
        organizationId,
        customerId: customer.id,
        livemode,
        catalogKey: catalogEntry.key,
        tier: catalogEntry.tier,
        interval: catalogEntry.interval,
        catalogVersion: catalogEntry.version,
        stripeSubscriptionId: subscription.id,
        stripeStatus: subscription.status,
        currentPeriodStart: toDate(item.current_period_start),
        currentPeriodEnd: toDate(item.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: toDate(subscription.canceled_at),
        providerSyncedAt: eventTimestamp,
      })
      await projectSubscriptionEntitlement(tx, organizationId, {
        tier: catalogEntry.tier,
        stripeStatus: subscription.status,
        interval: catalogEntry.interval,
        currentPeriodStart: toDate(item.current_period_start),
        currentPeriodEnd: toDate(item.current_period_end),
        seatLimit: catalogEntry.seatLimit,
      })
      // Voluntary Checkout cutover (§10 "Migrate manual entitlements without charging"): this is the
      // FIRST Stripe subscription this organization has ever had — end any overlapping manual
      // authority (legacy trialEndsAt/notes, any still-active legacy_manual credit grant) atomically
      // in the same transaction.
      await endOverlappingManualAuthority(tx, organizationId)
      return { outcome: 'applied', detail: `Created subscription record for ${subscription.id} (${isNewSubscriptionRecord ? 'first sighting' : 'resolved via customer'})` }
    }

    await updateBillingSubscriptionFromStripe(tx, organizationId, subscription.id, {
      stripeStatus: subscription.status,
      currentPeriodStart: toDate(item.current_period_start),
      currentPeriodEnd: toDate(item.current_period_end),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      canceledAt: toDate(subscription.canceled_at),
      providerSyncedAt: eventTimestamp,
    })
    if (subscription.status === 'active' || subscription.status === 'trialing') {
      if (existing.paymentBlockedAt) {
        await unfreezeStillValidGrantsOnRecovery(tx, organizationId, subscription.id, eventTimestamp)
      }
      await clearBillingSubscriptionPaymentBlock(tx, organizationId, subscription.id)
    }
    const existingCatalogEntry = resolveSubscriptionCatalogEntryByKey(existing.catalogKey)
    if (existingCatalogEntry) {
      await projectSubscriptionEntitlement(tx, organizationId, {
        tier: existingCatalogEntry.tier,
        stripeStatus: subscription.status,
        interval: existingCatalogEntry.interval,
        currentPeriodStart: toDate(item.current_period_start),
        currentPeriodEnd: toDate(item.current_period_end),
        seatLimit: existingCatalogEntry.seatLimit,
      })
    }
    return { outcome: 'applied', detail: `Updated subscription ${subscription.id} to status ${subscription.status} (${decision.reason})` }
  }, db)
}

async function handleSubscriptionDeleted(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb): Promise<WebhookHandlerOutcome> {
  const subscription = event.data.object as Stripe.Subscription
  const eventTimestamp = new Date(event.created * 1000)

  const organizationId = await findOrganizationIdForStripeSubscription(subscription.id, db)
  if (!organizationId) {
    return { outcome: 'deferred', detail: `No subscription record found yet for ${subscription.id}` }
  }

  return withWorkerOrganization(organizationId, async (tx) => {
    const existing = await findFullBillingSubscriptionByStripeId(tx, organizationId, subscription.id)
    if (!existing) return { outcome: 'deferred', detail: `Subscription row not found inside org scope for ${subscription.id}` }

    const decision = resolveSubscriptionTransition(
      { status: existing.stripeStatus, providerSyncedAt: existing.providerSyncedAt },
      { status: 'canceled', eventTimestamp },
    )
    if (!decision.apply) {
      return { outcome: 'ignored', detail: `Subscription ${subscription.id} deletion rejected: ${decision.reason}` }
    }

    await updateBillingSubscriptionFromStripe(tx, organizationId, subscription.id, {
      stripeStatus: 'canceled',
      currentPeriodStart: existing.currentPeriodStart,
      currentPeriodEnd: existing.currentPeriodEnd,
      cancelAtPeriodEnd: true,
      canceledAt: toDate(subscription.canceled_at) ?? eventTimestamp,
      providerSyncedAt: eventTimestamp,
    })
    const existingCatalogEntry = resolveSubscriptionCatalogEntryByKey(existing.catalogKey)
    if (existingCatalogEntry) {
      await projectSubscriptionEntitlement(tx, organizationId, {
        tier: existingCatalogEntry.tier,
        stripeStatus: 'canceled',
        interval: existingCatalogEntry.interval,
        currentPeriodStart: existing.currentPeriodStart,
        currentPeriodEnd: existing.currentPeriodEnd,
        seatLimit: existingCatalogEntry.seatLimit,
      })
    }
    return { outcome: 'applied', detail: `Subscription ${subscription.id} marked canceled` }
  }, db)
}

async function handleInvoicePaid(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb, authDb?: PostgresJsDatabase): Promise<WebhookHandlerOutcome> {
  const invoice = event.data.object as Stripe.Invoice
  const stripeSubscriptionId = extractId(invoice.parent?.subscription_details?.subscription ?? null)
  if (!stripeSubscriptionId) {
    return { outcome: 'ignored', detail: `Invoice ${invoice.id} is not linked to a subscription (not this task's concern)` }
  }

  const organizationId = await findOrganizationIdForStripeSubscription(stripeSubscriptionId, db)
  if (!organizationId) {
    return { outcome: 'deferred', detail: `No subscription found yet for ${stripeSubscriptionId} — awaiting customer.subscription.created` }
  }

  return withWorkerOrganization(organizationId, async (tx) => {
    const subscription = await findFullBillingSubscriptionByStripeId(tx, organizationId, stripeSubscriptionId)
    if (!subscription) return { outcome: 'deferred', detail: `Subscription row not found inside org scope for ${stripeSubscriptionId}` }

    // The subscription's own recorded catalogKey (set when the row was created) is the source of
    // truth for how many credits its plan grants — never re-derived from the invoice's line items,
    // which would require depending on their exact (API-version-sensitive) shape for no benefit.
    const catalogEntry = resolveSubscriptionCatalogEntryByKey(subscription.catalogKey)
    if (!catalogEntry) {
      return { outcome: 'ignored', detail: `Subscription ${stripeSubscriptionId}'s catalog key ${subscription.catalogKey} no longer resolves` }
    }

    const periodEnd = toDate(invoice.period_end) ?? new Date(event.created * 1000 + 30 * 24 * 60 * 60 * 1000)
    const source = subscription.interval === 'annual' ? 'subscription_annual_window' : 'subscription_monthly'
    // An annual subscription's own recorded periodStart is the billing anchor: this invoice's
    // credits are window 1 of 12 (annual-grants.ts issues windows 2-12), so — per spec.md — they
    // expire at the FIRST calendar anniversary, not at the full year's end.
    const expiresAt = subscription.interval === 'annual' && subscription.currentPeriodStart
      ? computeAnniversary(subscription.currentPeriodStart, 1)
      : periodEnd
    const monthlyWindowKey = subscription.interval === 'annual'
      ? `${stripeSubscriptionId}:window-1`
      : undefined

    try {
      const result = await grantCredits(tx, {
        grantId: randomUUID(),
        ledgerEntryId: randomUUID(),
        organizationId,
        source,
        sourceReference: stripeSubscriptionId,
        stripePaymentReference: invoice.id,
        monthlyWindowKey,
        units: catalogEntry.monthlyCredits,
        expiresAt,
        idempotencyKey: `invoice-grant:${invoice.id}`,
      })
      // Only on a genuinely NEW grant, never on a duplicate/retried delivery replay — §9 task 4's
      // "delivery dedupe" requirement: `grantCredits`'s own idempotency check already tells us
      // definitively whether this is the first time this invoice was applied.
      if (!result.replayed) {
        await sendInvoiceReceipt(tx, organizationId, invoice, authDb)
      }
      return {
        outcome: 'applied',
        detail: result.replayed
          ? `Invoice ${invoice.id} already granted credits — duplicate delivery, no-op`
          : `Granted ${catalogEntry.monthlyCredits} credits for invoice ${invoice.id}`,
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('already granted')) {
        return { outcome: 'applied', detail: `Monthly window already granted for subscription ${stripeSubscriptionId} — no-op` }
      }
      throw error
    }
  }, db)
}

async function handleInvoicePaymentFailed(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb, authDb?: PostgresJsDatabase): Promise<WebhookHandlerOutcome> {
  const invoice = event.data.object as Stripe.Invoice
  const stripeSubscriptionId = extractId(invoice.parent?.subscription_details?.subscription ?? null)
  if (!stripeSubscriptionId) {
    return { outcome: 'ignored', detail: `Invoice ${invoice.id} is not linked to a subscription` }
  }

  const organizationId = await findOrganizationIdForStripeSubscription(stripeSubscriptionId, db)
  if (!organizationId) {
    return { outcome: 'deferred', detail: `No subscription found yet for ${stripeSubscriptionId}` }
  }

  return withWorkerOrganization(organizationId, async (tx) => {
    const gracePeriodEndsAt = new Date(event.created * 1000 + GRACE_PERIOD_MS)
    const graceJustStarted = await markBillingSubscriptionGraceStart(tx, organizationId, stripeSubscriptionId, gracePeriodEndsAt)
    // Payment failure is critical enough that it ALWAYS also reaches the owner, even when a separate
    // billing contact exists (§9 task 4) — and, like the receipt above, sent at most once per grace
    // window, never on a duplicate/retried delivery.
    if (graceJustStarted) {
      await sendPaymentFailedNotice(tx, organizationId, authDb)
    }
    return {
      outcome: 'applied',
      detail: `Grace period marker set for subscription ${stripeSubscriptionId} (ends ${gracePeriodEndsAt.toISOString()}) — the dunning worker (§7 task 6) owns acting on it`,
    }
  }, db)
}

/** §9 task 4: sends a receipt to the verified billing contact (if any) AND the owner — never only one, so an org without a separate contact still gets its receipt at the owner's own address. */
async function sendInvoiceReceipt(tx: WorkerTransaction, organizationId: string, invoice: Stripe.Invoice, authDb?: PostgresJsDatabase): Promise<void> {
  const recipients = await billingNotificationRecipients(tx, organizationId, authDb)
  const details = { description: `Payment received for invoice ${invoice.number ?? invoice.id}`, amountCents: invoice.amount_paid, currency: invoice.currency }
  await Promise.all(recipients.map((to) => sendBillingReceiptEmail(to, details)))
}

/** §9 task 4: "critical messages also reach owner" — payment failure always reaches the owner regardless of whether a separate billing contact is also notified. */
async function sendPaymentFailedNotice(tx: WorkerTransaction, organizationId: string, authDb?: PostgresJsDatabase): Promise<void> {
  const recipients = await billingNotificationRecipients(tx, organizationId, authDb)
  await Promise.all(recipients.map((to) => sendBillingPaymentFailedEmail(to)))
}
