/**
 * Subscription preview and change matrix (plans/stripe-billing-platform/tasks.md §7 "Implement
 * subscription preview and change matrix"; spec.md §Changes). The caller (route handler) is
 * responsible for owner-only permission enforcement — this module never checks `principal.role`
 * itself, matching every other billing service file's separation of concerns.
 *
 * The change matrix (spec.md, verbatim):
 * - Upgrade (higher tier, same interval): preview exact Stripe invoice/tax, apply immediately via
 *   proration, only after successful payment. Grant
 *   `ceil((new allowance - old allowance) * remaining seconds / window seconds)` credits expiring at
 *   the CURRENT credit window's end (never a new window).
 * - Monthly to annual at the same tier: immediate after preview; the current credit window remains
 *   as-is (no duplicate grant) — Stripe's own invoice-level proration credits unused monthly time.
 * - Downgrade, cancellation, or annual to monthly: SCHEDULED for the Stripe billing period's end,
 *   never applied immediately or charged now. An annual customer remains contracted through the
 *   annual end, not the next monthly credit anniversary. Recorded in `billing_subscriptions.scheduledChange`
 *   — task 7.5 ("Implement cancellation and renewal-safe price migration") owns enacting it at
 *   renewal; this module only ever records the intent.
 * - A tier change that ALSO changes interval in a way not enumerated above (e.g. simultaneously
 *   changing tier and switching annual-to-monthly) is conservatively scheduled, never charged
 *   immediately — this is a deliberate, documented fallback for a combination spec.md does not
 *   define, not a gap that silently charges the wrong amount.
 *
 * Stale-preview protection: rather than a separate short-lived preview record, the preview response
 * carries a `fingerprint` derived from the subscription's own `providerSyncedAt` (already bumped by
 * every webhook-confirmed update). `changeSubscription` re-reads the current subscription and
 * rejects if the fingerprint no longer matches — the subscription changed (a renewal, a webhook, a
 * concurrent change) since the preview was computed, and the client must re-preview. The client
 * NEVER supplies a charge amount; every number is re-resolved server-side on every call.
 */
import { randomUUID } from 'node:crypto'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { getSeatUsage, type SeatDowngradeBlockerDto } from '../organizations/contracts'
import { computeAnniversary } from './annual-grants'
import { resolveSubscriptionCatalogEntryByKey, resolveSubscriptionCatalogKey, type SubscriptionCatalogEntry } from './catalog'
import { findGrantedByIdempotencyKey, grantCredits } from './credits'
import {
  applyImmediateSubscriptionChange,
  findFullActiveBillingSubscription,
  scheduleBillingSubscriptionChange,
  type FullBillingSubscriptionRecord,
} from '../repositories/billing'
import { BillingProviderError, type BillingProvider } from './provider'
import { idempotencyKeyFor, isLiveMode } from './stripe-client'

/**
 * Team-to-one-seat-tier downgrades must never be sent to Stripe while the organization still has
 * more accepted members plus usable invitations than the target tier's seat limit allows
 * (plans/stripe-billing-platform/tasks.md §7 "Enforce Team downgrade seat blockers"). Reuses the
 * SAME seat count (`getSeatUsage`) the invite-time limit already enforces — an owner never sees two
 * different seat numbers for the same organization from two different features.
 */
export async function resolveSeatDowngradeBlocker(
  principal: TenantPrincipal,
  targetSeatLimit: number,
): Promise<SeatDowngradeBlockerDto | null> {
  const seatUsage = await getSeatUsage(principal)
  if (seatUsage.used <= targetSeatLimit) return null
  return { currentSeatsUsed: seatUsage.used, targetSeatLimit, manageTeamUrl: '/settings/team' }
}

export type SubscriptionChangeErrorCode =
  | 'no_active_subscription'
  | 'unknown_catalog_key'
  | 'unresolvable_current_plan'
  | 'no_price_configured'
  | 'stale_preview'
  | 'payment_failed'
  | 'requires_action'
  | 'seat_limit_exceeded'

export class SubscriptionChangeError extends Error {
  constructor(
    message: string,
    readonly code: SubscriptionChangeErrorCode,
    /** Populated for `seat_limit_exceeded` — the owner-visible blocker to render, never an instruction to evict/cancel anything automatically. */
    readonly seatBlocker?: SeatDowngradeBlockerDto,
  ) {
    super(message)
    this.name = 'SubscriptionChangeError'
  }
}

export type ChangeDirection = 'upgrade' | 'downgrade' | 'lateral'
export type ChangeTiming = 'immediate' | 'scheduled'

export interface SubscriptionChangeClassification {
  direction: ChangeDirection
  timing: ChangeTiming
}

const TIER_RANK: Record<'pro' | 'pro_max' | 'team', number> = { pro: 1, pro_max: 2, team: 3 }
const INTERVAL_RANK: Record<'monthly' | 'annual', number> = { monthly: 1, annual: 2 }

/** Pure — no I/O. See this file's top-of-file comment for the exact matrix this implements. */
export function classifySubscriptionChange(
  current: { tier: 'pro' | 'pro_max' | 'team'; interval: 'monthly' | 'annual' },
  next: { tier: 'pro' | 'pro_max' | 'team'; interval: 'monthly' | 'annual' },
): SubscriptionChangeClassification {
  const tierDelta = TIER_RANK[next.tier] - TIER_RANK[current.tier]
  const intervalDelta = INTERVAL_RANK[next.interval] - INTERVAL_RANK[current.interval]

  if (tierDelta === 0 && intervalDelta === 0) return { direction: 'lateral', timing: 'immediate' }
  if (tierDelta > 0 && intervalDelta === 0) return { direction: 'upgrade', timing: 'immediate' }
  if (tierDelta === 0 && intervalDelta > 0) return { direction: 'upgrade', timing: 'immediate' } // monthly -> annual, same tier
  if (tierDelta === 0 && intervalDelta < 0) return { direction: 'downgrade', timing: 'scheduled' } // annual -> monthly, same tier
  if (tierDelta < 0 && intervalDelta === 0) return { direction: 'downgrade', timing: 'scheduled' }
  // Simultaneous tier AND interval change: not enumerated by spec.md — conservatively scheduled.
  return { direction: tierDelta > 0 ? 'upgrade' : 'downgrade', timing: 'scheduled' }
}

export interface CreditWindow {
  windowStart: Date
  windowEnd: Date
}

/**
 * Which credit window `now` currently falls in. A monthly subscriber has exactly one window per
 * period (`currentPeriodStart`/`currentPeriodEnd`). An annual subscriber's credits are windowed
 * MONTHLY (annual-grants.ts) — this walks the same 12 calendar-anniversary windows to find the one
 * containing `now`, so an upgrade's ceiling-delta credits always expire with the current MONTHLY
 * window, never the full year.
 */
export function resolveCurrentCreditWindow(
  subscription: { interval: 'monthly' | 'annual'; currentPeriodStart: Date; currentPeriodEnd: Date },
  now: Date,
): CreditWindow {
  if (subscription.interval === 'monthly') {
    return { windowStart: subscription.currentPeriodStart, windowEnd: subscription.currentPeriodEnd }
  }
  for (let index = 1; index <= 12; index += 1) {
    const windowStart = index === 1 ? subscription.currentPeriodStart : computeAnniversary(subscription.currentPeriodStart, index - 1)
    const windowEnd = index === 12 ? subscription.currentPeriodEnd : computeAnniversary(subscription.currentPeriodStart, index)
    if (now >= windowStart && now < windowEnd) return { windowStart, windowEnd }
  }
  // Past the full year (should not happen for a still-active subscription) — the last window.
  return { windowStart: computeAnniversary(subscription.currentPeriodStart, 11), windowEnd: subscription.currentPeriodEnd }
}

/** Pure — no I/O. spec.md's exact formula: `ceil((new allowance - old allowance) * remaining seconds / window seconds)`. Never negative — a same-or-lower allowance change yields 0, never a debit (a downgrade is scheduled, never immediate, so this path never runs for a decrease anyway). */
export function computeUpgradeCreditDelta(params: { oldMonthlyCredits: number; newMonthlyCredits: number; window: CreditWindow; now: Date }): number {
  const windowSeconds = (params.window.windowEnd.getTime() - params.window.windowStart.getTime()) / 1000
  if (windowSeconds <= 0) return 0
  const remainingSeconds = Math.max(0, (params.window.windowEnd.getTime() - params.now.getTime()) / 1000)
  const allowanceDelta = params.newMonthlyCredits - params.oldMonthlyCredits
  if (allowanceDelta <= 0) return 0
  return Math.ceil((allowanceDelta * remainingSeconds) / windowSeconds)
}

function subscriptionFingerprint(subscription: Pick<FullBillingSubscriptionRecord, 'stripeSubscriptionId' | 'providerSyncedAt'>): string {
  return `${subscription.stripeSubscriptionId}:${subscription.providerSyncedAt.toISOString()}`
}

async function resolveChangeInputs(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  newCatalogKey: string,
): Promise<{
  subscription: FullBillingSubscriptionRecord
  currentCatalogEntry: SubscriptionCatalogEntry
  newCatalogEntry: SubscriptionCatalogEntry
  classification: SubscriptionChangeClassification
  newPriceId: string
  livemode: boolean
}> {
  const livemode = isLiveMode()
  const subscription = await findFullActiveBillingSubscription(transaction, principal.organizationId, livemode)
  if (!subscription) throw new SubscriptionChangeError('No active subscription for this organization', 'no_active_subscription')

  const currentCatalogEntry = resolveSubscriptionCatalogEntryByKey(subscription.catalogKey)
  if (!currentCatalogEntry) throw new SubscriptionChangeError(`Current catalog key ${subscription.catalogKey} no longer resolves`, 'unresolvable_current_plan')

  const newCatalogEntry = resolveSubscriptionCatalogKey(newCatalogKey)
  if (!newCatalogEntry) throw new SubscriptionChangeError(`Unknown or retired catalog key: ${newCatalogKey}`, 'unknown_catalog_key')

  const newPriceId = livemode ? newCatalogEntry.stripePriceId.live : newCatalogEntry.stripePriceId.test
  if (!newPriceId) throw new SubscriptionChangeError(`No ${livemode ? 'live' : 'test'} Stripe Price ID configured for ${newCatalogKey}`, 'no_price_configured')

  const classification = classifySubscriptionChange(
    { tier: currentCatalogEntry.tier, interval: currentCatalogEntry.interval },
    { tier: newCatalogEntry.tier, interval: newCatalogEntry.interval },
  )

  return { subscription, currentCatalogEntry, newCatalogEntry, classification, newPriceId, livemode }
}

export interface SubscriptionChangePreview {
  currentCatalogKey: string
  newCatalogKey: string
  direction: ChangeDirection
  timing: ChangeTiming
  stripeAmountDue: number
  stripeCurrency: string
  nextPaymentDate: string
  creditDelta: number
  effectiveAt: string
  /** Echo back verbatim to `changeSubscription` — proves the subscription hasn't changed since this preview was computed. Never a charge amount. */
  fingerprint: string
  /** Present only for a downgrade the organization's current seat usage doesn't yet allow — shown proactively so an owner sees why BEFORE attempting to confirm, not just as a rejection after the fact. */
  seatBlocker?: SeatDowngradeBlockerDto
}

export interface SubscriptionChangeOptions {
  provider: BillingProvider
  now?: () => Date
}

export async function previewSubscriptionChange(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: { newCatalogKey: string },
  options: SubscriptionChangeOptions,
): Promise<SubscriptionChangePreview> {
  const now = (options.now ?? (() => new Date()))()
  const { subscription, currentCatalogEntry, newCatalogEntry, classification, newPriceId } = await resolveChangeInputs(transaction, principal, input.newCatalogKey)

  const stripePreview = await options.provider.previewSubscriptionChange({ subscriptionId: subscription.stripeSubscriptionId, newPriceId })

  let creditDelta = 0
  let effectiveAt = now.toISOString()
  let seatBlocker: SeatDowngradeBlockerDto | null = null
  if (classification.timing === 'immediate' && classification.direction === 'upgrade' && currentCatalogEntry.tier !== newCatalogEntry.tier) {
    const window = resolveCurrentCreditWindow(
      { interval: currentCatalogEntry.interval, currentPeriodStart: subscription.currentPeriodStart ?? now, currentPeriodEnd: subscription.currentPeriodEnd ?? now },
      now,
    )
    creditDelta = computeUpgradeCreditDelta({ oldMonthlyCredits: currentCatalogEntry.monthlyCredits, newMonthlyCredits: newCatalogEntry.monthlyCredits, window, now })
  } else if (classification.timing === 'scheduled') {
    effectiveAt = (subscription.currentPeriodEnd ?? now).toISOString()
    seatBlocker = await resolveSeatDowngradeBlocker(principal, newCatalogEntry.seatLimit)
  }

  return {
    currentCatalogKey: subscription.catalogKey,
    newCatalogKey: newCatalogEntry.key,
    direction: classification.direction,
    timing: classification.timing,
    stripeAmountDue: stripePreview.amountDue,
    stripeCurrency: stripePreview.currency,
    nextPaymentDate: stripePreview.nextPaymentDate,
    creditDelta,
    effectiveAt,
    fingerprint: subscriptionFingerprint(subscription),
    ...(seatBlocker ? { seatBlocker } : {}),
  }
}

export interface SubscriptionChangeResult {
  applied: ChangeTiming
  newCatalogKey: string
  effectiveAt: string
  creditDelta: number
}

export interface SubscriptionChangeInput {
  newCatalogKey: string
  /** From a prior `previewSubscriptionChange` call — rejected if the subscription has changed since. */
  fingerprint: string
  idempotencyKey: string
}

export async function changeSubscription(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: SubscriptionChangeInput,
  options: SubscriptionChangeOptions,
): Promise<SubscriptionChangeResult> {
  const now = (options.now ?? (() => new Date()))()
  const { subscription, currentCatalogEntry, newCatalogEntry, classification, newPriceId } = await resolveChangeInputs(transaction, principal, input.newCatalogKey)

  // Already on the target catalog key — either a genuinely lateral request (never had anything to
  // apply), or an immediate upgrade this exact request already applied on an earlier attempt (a
  // client retry, or the loser of a race against an identical concurrent request; `subscription` is
  // read fresh every call, so a repeat of the SAME request sees its own prior work here). Either
  // way there's nothing left to charge, schedule, or protect with a fingerprint check — only the
  // credit-delta figure differs, read back from the ledger by this request's own idempotency key
  // rather than recomputed (recomputing now would see old tier === new tier and wrongly report 0
  // for what was originally a real, nonzero upgrade grant).
  if (subscription.catalogKey === newCatalogEntry.key) {
    const alreadyGranted = await findGrantedByIdempotencyKey(transaction, principal.organizationId, `upgrade-delta:${principal.organizationId}:${input.idempotencyKey}`)
    return {
      applied: 'immediate',
      newCatalogKey: newCatalogEntry.key,
      effectiveAt: subscription.providerSyncedAt.toISOString(),
      creditDelta: alreadyGranted?.grant.originalUnits ?? 0,
    }
  }

  if (classification.timing === 'scheduled') {
    // Never send Stripe (or even record our own schedule) while current seat usage exceeds the
    // target tier's limit — checked before the fingerprint, since this is the invariant an owner
    // most needs surfaced clearly, and it's independent of whether the preview itself went stale.
    const seatBlocker = await resolveSeatDowngradeBlocker(principal, newCatalogEntry.seatLimit)
    if (seatBlocker) {
      throw new SubscriptionChangeError(
        `Cannot schedule this downgrade: ${seatBlocker.currentSeatsUsed} seats in use exceeds the ${seatBlocker.targetSeatLimit}-seat limit for ${newCatalogEntry.key}`,
        'seat_limit_exceeded',
        seatBlocker,
      )
    }

    // A scheduled change never touches `providerSyncedAt` (see `scheduleBillingSubscriptionChange`),
    // so its fingerprint check here is never self-invalidated by our own prior work the way the
    // immediate path's would be — a genuine mismatch here always means something else changed the
    // subscription since the preview was generated.
    if (subscriptionFingerprint(subscription) !== input.fingerprint) {
      throw new SubscriptionChangeError('Subscription changed since the preview was generated — request a new preview', 'stale_preview')
    }
    const effectiveAt = (subscription.currentPeriodEnd ?? now).toISOString()
    await scheduleBillingSubscriptionChange(transaction, principal.organizationId, subscription.stripeSubscriptionId, {
      catalogKey: newCatalogEntry.key,
      effectiveAt,
    })
    return { applied: 'scheduled', newCatalogKey: newCatalogEntry.key, effectiveAt, creditDelta: 0 }
  }

  if (subscriptionFingerprint(subscription) !== input.fingerprint) {
    throw new SubscriptionChangeError('Subscription changed since the preview was generated — request a new preview', 'stale_preview')
  }

  // Immediate upgrade: the provider call carries the real charge — "apply only after successful
  // payment" — so our own state is only touched once this resolves AND confirms an active result.
  // A thrown error (decline/timeout) and a non-`active` result (e.g. `incomplete` — SCA still
  // pending) are both "not yet paid": neither ever reaches `applyImmediateSubscriptionChange`.
  let providerResult
  try {
    providerResult = await options.provider.changeSubscription({
      subscriptionId: subscription.stripeSubscriptionId,
      newPriceId,
      idempotencyKey: idempotencyKeyFor('change-subscription', principal.organizationId, input.idempotencyKey),
    })
  } catch (error) {
    if (error instanceof BillingProviderError) {
      throw new SubscriptionChangeError(`Payment failed: ${error.message}`, 'payment_failed')
    }
    throw error
  }
  if (providerResult.status !== 'active') {
    throw new SubscriptionChangeError(
      `Subscription change requires further customer action (status: ${providerResult.status})`,
      'requires_action',
    )
  }

  await applyImmediateSubscriptionChange(transaction, principal.organizationId, subscription.stripeSubscriptionId, {
    catalogKey: newCatalogEntry.key,
    tier: newCatalogEntry.tier,
    interval: newCatalogEntry.interval,
    catalogVersion: newCatalogEntry.version,
    providerSyncedAt: now,
  })

  let creditDelta = 0
  if (currentCatalogEntry.tier !== newCatalogEntry.tier) {
    const window = resolveCurrentCreditWindow(
      { interval: currentCatalogEntry.interval, currentPeriodStart: subscription.currentPeriodStart ?? now, currentPeriodEnd: subscription.currentPeriodEnd ?? now },
      now,
    )
    creditDelta = computeUpgradeCreditDelta({ oldMonthlyCredits: currentCatalogEntry.monthlyCredits, newMonthlyCredits: newCatalogEntry.monthlyCredits, window, now })
    if (creditDelta > 0) {
      await grantCredits(transaction, {
        grantId: randomUUID(),
        ledgerEntryId: randomUUID(),
        organizationId: principal.organizationId,
        source: 'subscription_upgrade_delta',
        sourceReference: subscription.stripeSubscriptionId,
        units: creditDelta,
        expiresAt: window.windowEnd,
        idempotencyKey: `upgrade-delta:${principal.organizationId}:${input.idempotencyKey}`,
      })
    }
  }

  return { applied: 'immediate', newCatalogKey: newCatalogEntry.key, effectiveAt: now.toISOString(), creditDelta }
}
