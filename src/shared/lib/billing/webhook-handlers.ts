/**
 * Idempotent, monotonic Stripe webhook event handlers (plans/stripe-billing-platform/tasks.md §6
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
 * created/updated/failed; and dispute created/updated/closed/funds reinstated. The first three
 * families are fully actionable today (customers/checkout/credits/subscriptions already exist).
 * PaymentIntent, refund, and dispute events currently have nothing to reconcile against — packs
 * (§8 task 1), refund review (§8 task 4), and dispute handling (§8 tasks 2-3) are later, dedicated
 * tasks — so those events are recorded as `'deferred'`, a distinct, honest outcome from `'ignored'`
 * (a genuinely unrecognized event type): "deferred" means the worker (§6 task 3) should leave the
 * row pending and revisit it once that later infrastructure exists, never that nothing needs to
 * happen.
 *
 * Webhook events reference Stripe object ids (customer/subscription/checkout-session), never our
 * organizationId — resolving "which organization does this belong to" needs the cross-org lookup
 * `repositories/billing-worker.ts` documents and provides.
 */
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type Stripe from 'stripe'
import { computeAnniversary } from './annual-grants'
import { resolveSubscriptionCatalogEntryByKey, resolveSubscriptionCatalogEntryByStripePriceId } from './catalog'
import { grantCredits } from './credits'
import { unfreezeStillValidGrantsOnRecovery } from './dunning'
import { findBillingCustomer } from '../repositories/billing'
import {
  clearBillingSubscriptionPaymentBlock,
  findBillingCheckoutAttemptByStripeSessionId,
  findFullBillingSubscriptionByStripeId,
  findOrganizationIdForStripeCheckoutSession,
  findOrganizationIdForStripeCustomer,
  findOrganizationIdForStripeSubscription,
  markBillingSubscriptionGraceStart,
  updateBillingCheckoutAttemptStatus,
  updateBillingSubscriptionFromStripe,
  withWorkerOrganization,
} from '../repositories/billing-worker'
import { workerDb } from '../db/worker-db'
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
}

export async function processStripeWebhookEvent(
  event: Stripe.Event,
  options: ProcessStripeWebhookEventOptions = {},
): Promise<WebhookHandlerOutcome> {
  const livemode = options.livemode ?? event.livemode
  const db = options.db ?? workerDb

  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutSessionStatus(event.data.object as Stripe.Checkout.Session, 'complete', db)
    case 'checkout.session.expired':
      return handleCheckoutSessionStatus(event.data.object as Stripe.Checkout.Session, 'expired', db)

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return handleSubscriptionUpsert(event, livemode, db)
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event, db)

    case 'invoice.paid':
      return handleInvoicePaid(event, db)
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(event, db)

    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'payment_intent.requires_action':
      return { outcome: 'deferred', detail: `${event.type}: packs are not built yet (plans/stripe-billing-platform/tasks.md §8 task 1)` }

    case 'charge.refunded':
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      return { outcome: 'deferred', detail: `${event.type}: refund review is not built yet (§8 task 4)` }

    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_reinstated':
      return { outcome: 'deferred', detail: `${event.type}: dispute handling is not built yet (§8 tasks 2-3)` }

    default:
      return { outcome: 'ignored', detail: `Unrecognized event type: ${event.type}` }
  }
}

async function handleCheckoutSessionStatus(
  session: Stripe.Checkout.Session,
  status: 'complete' | 'expired',
  db: PostgresJsDatabase | typeof workerDb,
): Promise<WebhookHandlerOutcome> {
  if (session.mode !== 'subscription') {
    return { outcome: 'deferred', detail: 'Non-subscription-mode Checkout Sessions (packs) are not built yet' }
  }

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
    return { outcome: 'applied', detail: `Checkout attempt ${attempt.id} marked ${status}` }
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

async function handleInvoicePaid(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb): Promise<WebhookHandlerOutcome> {
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

async function handleInvoicePaymentFailed(event: Stripe.Event, db: PostgresJsDatabase | typeof workerDb): Promise<WebhookHandlerOutcome> {
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
    await markBillingSubscriptionGraceStart(tx, organizationId, stripeSubscriptionId, gracePeriodEndsAt)
    return {
      outcome: 'applied',
      detail: `Grace period marker set for subscription ${stripeSubscriptionId} (ends ${gracePeriodEndsAt.toISOString()}) — the dunning worker (§7 task 6) owns acting on it`,
    }
  }, db)
}
