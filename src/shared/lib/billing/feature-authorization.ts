import { randomUUID } from 'node:crypto'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { env } from '../env'
import {
  checkFirstPayerSpendVelocityAndEmit,
  checkPoolDrainAndEmit,
  checkRefundFarmingAndEmit,
  detectFirstPayerCapExceeded,
  detectPoolDrain,
  detectRefundCapExceeded,
  isWithinFirstPayerWindow,
} from '../abuse/credit-abuse'
import type { EmitAbuseSignalDeps } from '../abuse/signals'
import { getSeatUsage, incrementSeatUsage, listSeatUsageForOrgDay } from '../repositories/seat-usage'
import { findActiveBillingSubscription } from '../repositories/billing'
import type { BillingCreditAllocationRecord, BillingCreditReservationRecord } from '../repositories/billing-ledger'
import {
  findCreditGrant,
  findEarliestPaidGrantCreatedAt,
  findLedgerEntryByIdempotencyKey,
  insertLedgerEntry,
  listAllocationsForReservation,
  lockReservation,
  sumRefundedUnitsSince,
  sumReservedUnitsSince,
  sumSettledUnitsSince,
  updateAllocationConsumed,
} from '../repositories/billing-ledger'
import { adjustCreditGrant, grantCredits, isActivePaidSubscription } from './credits'
import type { CatalogTier } from './catalog'
import { getRateCard, tierMeetsMinimum, type RateCard } from './rate-cards'
import { getBetaModeState, type BetaModeState } from './beta-mode'
import { activeBetaSourceReference, ensureBetaMonthlyCreditGrant } from './beta-credits'
import { applyBetaModeEntitlement } from './effective-entitlement'
import { getOrganizationEntitlement } from '../repositories/entitlements'

const CATALOG_TIERS: ReadonlySet<string> = new Set<CatalogTier>(['free', 'pro', 'pro_max', 'team'])
function isCatalogTier(value: string): value is CatalogTier {
  return CATALOG_TIERS.has(value)
}
import { withCreditWriteRole } from './credit-write-role'
import {
  extendReservation as extendReservationRaw,
  releaseReservation as releaseReservationRaw,
  reserveCredits as reserveCreditsRaw,
  ReservationError,
  settleReservation as settleReservationRaw,
} from './reservations'

/**
 * The ONLY surface feature code may use to authorize and pay for AI-powered
 * work (plans/phase-1/30-stripe-billing-platform/tasks.md §4 "Expose server-only
 * feature billing contracts"; spec.md §Credit authorization contract).
 * Feature code never touches `reservations.ts`/`credits.ts` directly, never
 * reads or mutates balances itself, and never begins a provider-backed
 * operation before `reserveCredits` here returns successfully.
 *
 * Every reservation is bound to a server-owned `RateCard` (`rate-cards.ts`)
 * looked up by `operation` name — the caller supplies only the operation and
 * an idempotency key, never a unit count or duration, so client input can
 * never widen what a feature is allowed to spend or how long it can hold a
 * reservation.
 */

export class FeatureBillingError extends Error {
  constructor(message: string, readonly code: 'unknown_feature' | 'insufficient_entitlement' | 'insufficient_credits' | 'blocked' | 'invalid_state') {
    super(message)
    this.name = 'FeatureBillingError'
  }
}

export interface CheckEntitlementInput {
  feature: string
}

export type EntitlementCheckResult =
  | { allowed: true }
  | { allowed: false; reason: 'unknown_feature' | 'no_subscription' | 'tier_too_low' }

/** Read-only — never mutates a balance or reservation. Feature code should call this before showing an action as available, but `reserveCredits` below re-checks it server-side regardless (never trust a client's own earlier entitlement check). */
export async function checkEntitlement(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: CheckEntitlementInput,
  /**
   * The beta state the caller already read, if it has one.
   *
   * `reserveCredits` reads it once and threads it through, because reading it twice inside one
   * reservation takes the shared advisory lock twice and — worse — lets the second read disagree with
   * the first if a disable commits between them. A caller with nothing to thread passes nothing and
   * this reads for itself.
   */
  betaState?: Pick<BetaModeState, 'enabled'>,
): Promise<EntitlementCheckResult> {
  const rateCard = getRateCard(input.feature)
  if (!rateCard) return { allowed: false, reason: 'unknown_feature' }
  if (!rateCard.minimumTier) return { allowed: true }

  /**
   * Beta mode authorizes from the **entitlement**, not from a Stripe subscription (plan 58).
   *
   * This branch is the whole reason plan 58 exists. The path below reads
   * `findActiveBillingSubscription`, and `STRIPE_BILLING_ENABLED` is false in every environment — so
   * there is no active subscription anywhere and every rate-carded feature answers `no_subscription`.
   * Raising a tier elsewhere changes nothing here, which is exactly the inconsistency the plan
   * describes: the UI and the non-metered limits saying Pro Max while provider-backed work still
   * refuses.
   *
   * `getBetaModeState` throws rather than returning false when it cannot read the row, and that throw
   * must propagate. Answering `allowed: false` on a database error would deny a paying customer and
   * read, to every surface above, as the flag simply being off.
   */
  const beta = betaState ?? await getBetaModeState(transaction)
  if (beta.enabled) {
    const effective = applyBetaModeEntitlement(
      await getOrganizationEntitlement(transaction, principal.organizationId),
      beta,
    )
    /**
     * `paymentBlocked` still wins, and it reports as `no_subscription` on purpose.
     *
     * Not a fourth reason code: every consumer of `EntitlementCheckResult` — the UI copy, the abuse
     * signals, `billing-state.ts` — would grow a branch for a state that is operationally identical to
     * "you cannot pay right now". An organization in dunning must not get free provider work by way of
     * a promotional flag.
     */
    if (!effective.paidActionsAllowed) return { allowed: false, reason: 'no_subscription' }
    return tierMeetsMinimum(effective.tier, rateCard.minimumTier)
      ? { allowed: true }
      : { allowed: false, reason: 'tier_too_low' }
  }

  const subscription = await findActiveBillingSubscription(transaction, principal.organizationId, false)
  if (!subscription || !isActivePaidSubscription(subscription)) return { allowed: false, reason: 'no_subscription' }
  if (!isCatalogTier(subscription.tier) || !tierMeetsMinimum(subscription.tier, rateCard.minimumTier)) {
    return { allowed: false, reason: 'tier_too_low' }
  }
  return { allowed: true }
}

async function requireEntitledRateCard(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  feature: string,
  betaState?: Pick<BetaModeState, 'enabled'>,
): Promise<RateCard> {
  const rateCard = getRateCard(feature)
  if (!rateCard) throw new FeatureBillingError(`Unknown feature: ${feature}`, 'unknown_feature')

  const entitlement = await checkEntitlement(transaction, principal, { feature }, betaState)
  if (!entitlement.allowed) {
    throw new FeatureBillingError(`Not entitled to ${feature}: ${entitlement.reason}`, 'insufficient_entitlement')
  }
  return rateCard
}

export interface ReserveCreditsInput {
  reservationId: string
  operation: string
  idempotencyKey: string
}

export interface FeatureReservationResult {
  reservation: BillingCreditReservationRecord
  allocations: BillingCreditAllocationRecord[]
}

/** The one call a feature makes before starting any provider-backed work. Throws `FeatureBillingError('insufficient_entitlement')` if the tier doesn't cover this feature, or `('insufficient_credits')` if the reservation itself fails — either way, the caller must not proceed. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function reserveCredits(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: ReserveCreditsInput,
  deps?: EmitAbuseSignalDeps,
): Promise<FeatureReservationResult> {
  /**
   * One read of the flag for the whole reservation (plan 58).
   *
   * Read once and threaded, because each extra read takes the shared advisory lock again and — worse —
   * a second read can disagree with the first if a disable commits between them. A reservation
   * authorized under "beta on" must allocate under "beta on" or refuse; it must never do half of each.
   */
  const beta = await getBetaModeState(transaction)
  const rateCard = await requireEntitledRateCard(transaction, principal, input.operation, beta)
  const today = todayUtc()
  const now = new Date()

  /**
   * The grant is minted here, just before the first non-zero reservation of the month can need it —
   * not by a sweep over every organization when the flag flips.
   *
   * Zero-cost operations are skipped deliberately: a free action must not be what creates a 700-unit
   * promotional grant, or an organization that never does paid work accrues an allowance every month
   * for nothing.
   */
  if (beta.enabled && rateCard.maxUnits > 0) {
    await withCreditWriteRole(transaction, () =>
      ensureBetaMonthlyCreditGrant(transaction, principal.organizationId, beta, now),
    )
  }
  const betaReference = activeBetaSourceReference(beta, principal.organizationId, now)

  // Per-seat credit sub-budget (Phase 4B "G2") — checked BEFORE reserving so a blocked seat never
  // partially reserves against the shared pool. Only a real `enforce`-mode gate; `observe`/`warn`
  // skip the query entirely and rely on the always-on signal below instead.
  if (env.ABUSE_ENFORCEMENT_MODE === 'enforce') {
    const existing = await getSeatUsage(transaction, principal.organizationId, principal.userId, today, 'messages')
    const orgUsageToday = await listSeatUsageForOrgDay(transaction, principal.organizationId, today, 'messages')
    const seatCount = new Set(orgUsageToday.map((row) => row.userId)).size + (existing ? 0 : 1)
    const seatUnitsAfterThisReservation = (existing?.creditUnits ?? 0) + rateCard.maxUnits
    if (detectPoolDrain({ seatUnits: seatUnitsAfterThisReservation, cap: env.CREDIT_SEAT_DAILY_UNITS, seatCount })) {
      throw new FeatureBillingError('This seat has reached its daily credit sub-budget', 'blocked')
    }
  }

  // First-payer credit-consumption cap (Phase 4B "G6") — only relevant while the org is still
  // inside its first-payer window; an established payer skips the (heavier) consumption-history
  // query entirely. `firstPaidGrantAt`/`isNewPayer` are computed once and reused below for the
  // always-on post-reservation signal, so a new payer's request costs exactly one extra query.
  const firstPaidGrantAt = await findEarliestPaidGrantCreatedAt(transaction, principal.organizationId)
  const isNewPayer = isWithinFirstPayerWindow({ firstPaidGrantAt, now, windowHours: env.CREDIT_FIRST_PAYER_WINDOW_HOURS })
  let unitsReservedInWindow = 0
  if (isNewPayer) {
    const windowStart = new Date(now.getTime() - env.CREDIT_FIRST_PAYER_WINDOW_HOURS * 60 * 60 * 1000)
    unitsReservedInWindow = await sumReservedUnitsSince(transaction, principal.organizationId, windowStart)
    if (
      env.ABUSE_ENFORCEMENT_MODE === 'enforce'
      && detectFirstPayerCapExceeded({ unitsReservedInWindow, thisReservationUnits: rateCard.maxUnits, cap: env.CREDIT_FIRST_PAYER_CAP_UNITS })
    ) {
      throw new FeatureBillingError('This organization has reached its new-payer credit consumption cap', 'blocked')
    }
  }

  try {
    const result = await withCreditWriteRole(transaction, () => reserveCreditsRaw(transaction, {
      reservationId: input.reservationId,
      organizationId: principal.organizationId,
      operation: input.operation,
      rateCardVersion: rateCard.version,
      idempotencyKey: input.idempotencyKey,
      maximumUnits: rateCard.maxUnits,
      maxDurationSeconds: rateCard.maxDurationSeconds,
      activeBetaSourceReference: betaReference,
    }))

    // Record the acting seat's credit units into seat_usage_daily on every reservation — always,
    // regardless of enforcement mode (this is the counter, not the gate). `pool_drain` is emitted
    // whenever a seat crosses its sub-cap; detection only here, never blocks (the enforce-mode
    // block already happened above, before any credits were reserved).
    const updatedSeatUsage = await incrementSeatUsage(transaction, {
      id: randomUUID(), organizationId: principal.organizationId, userId: principal.userId,
      day: today, action: 'messages', count: 1, creditUnits: rateCard.maxUnits,
    })
    const orgUsageAfter = await listSeatUsageForOrgDay(transaction, principal.organizationId, today, 'messages')
    const poolTotalUnits = orgUsageAfter.reduce((sum, row) => sum + row.creditUnits, 0)
    const seatCountAfter = new Set(orgUsageAfter.map((row) => row.userId)).size
    await checkPoolDrainAndEmit(
      {
        seatUnits: updatedSeatUsage.creditUnits,
        cap: env.CREDIT_SEAT_DAILY_UNITS,
        seatCount: seatCountAfter,
        poolTotalUnits,
      },
      { userId: principal.userId, organizationId: principal.organizationId, requestId: principal.requestId },
      deps,
    )

    // Always-on signal (any enforcement mode) — only queried a moment ago when the org is a new
    // payer, so this is a no-op cost for every established payer.
    if (isNewPayer) {
      await checkFirstPayerSpendVelocityAndEmit(
        {
          unitsReservedInWindow,
          thisReservationUnits: rateCard.maxUnits,
          cap: env.CREDIT_FIRST_PAYER_CAP_UNITS,
          windowHours: env.CREDIT_FIRST_PAYER_WINDOW_HOURS,
        },
        { userId: principal.userId, organizationId: principal.organizationId, requestId: principal.requestId },
        deps,
      )
    }

    return { reservation: result.reservation, allocations: result.allocations }
  } catch (error) {
    if (error instanceof ReservationError && error.code === 'insufficient_credits') {
      throw new FeatureBillingError('Insufficient credits for this operation', 'insufficient_credits')
    }
    throw error
  }
}

export interface ExtendReservationInput {
  reservationId: string
  additionalMaximumUnits: number
  idempotencyKey: string
}

/** A long-running operation calls this when it needs more budget than the initial reservation covered. If this throws, the caller MUST stop the provider-backed work immediately — never continue spending against an unextended reservation. */
export async function extendReservation(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: ExtendReservationInput,
): Promise<FeatureReservationResult> {
  try {
    /**
     * Re-read, not carried over. If beta mode ended while the provider was working, this extension must
     * not be able to draw on the allowance the reservation started under.
     */
    const beta = await getBetaModeState(transaction)
    const result = await withCreditWriteRole(transaction, () => extendReservationRaw(transaction, {
      organizationId: principal.organizationId,
      reservationId: input.reservationId,
      additionalMaximumUnits: input.additionalMaximumUnits,
      idempotencyKey: input.idempotencyKey,
      activeBetaSourceReference: activeBetaSourceReference(beta, principal.organizationId, new Date()),
    }))
    return { reservation: result.reservation, allocations: result.allocations }
  } catch (error) {
    if (error instanceof ReservationError && error.code === 'insufficient_credits') {
      throw new FeatureBillingError('Insufficient credits to extend this operation', 'insufficient_credits')
    }
    throw error
  }
}

export interface SettleReservationInput {
  reservationId: string
  actualUnits: number
  idempotencyKey: string
}

export async function settleReservation(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: SettleReservationInput,
): Promise<FeatureReservationResult> {
  const result = await withCreditWriteRole(transaction, () => settleReservationRaw(transaction, {
    organizationId: principal.organizationId,
    reservationId: input.reservationId,
    actualUnits: input.actualUnits,
    idempotencyKey: input.idempotencyKey,
    settlementGraceSeconds: 60,
  }))
  return { reservation: result.reservation, allocations: result.allocations }
}

export interface ReleaseReservationInput {
  reservationId: string
  reason?: string
  idempotencyKey: string
}

/** Called when the provider-backed operation never started or failed before consuming anything — releases the full hold back. */
export async function releaseReservation(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: ReleaseReservationInput,
): Promise<FeatureReservationResult> {
  const result = await withCreditWriteRole(transaction, () => releaseReservationRaw(transaction, {
    organizationId: principal.organizationId,
    reservationId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
  }))
  return { reservation: result.reservation, allocations: result.allocations }
}

export interface RefundUsageInput {
  /** The already-settled reservation whose consumed usage is being partly or fully refunded. */
  settlementId: string
  units: number
  reason: string
  idempotencyKey: string
  /** Required provider-side evidence justifying the refund (e.g. a provider error code, upstream refund/dispute id) — a usage refund is never accepted on the caller's say-so alone (abuse-and-usage-integrity "G4"). */
  providerEvidenceReference: string
}

export interface RefundUsageResult {
  reservation: BillingCreditReservationRecord
  refundedUnits: number
}

/**
 * Refunds previously-consumed units after settlement (e.g. a downstream provider call that was
 * settled as successful later turns out to have failed or been refunded upstream). Never mutates
 * the append-only ledger's history — credits the refunded amount back via a compensating
 * `adjustCreditGrant` on each allocation's original grant when that grant is still active, or a
 * fresh short-lived promotional grant when the original grant has since expired or been revoked
 * (an expired grant's `remainingUnits` must stay 0 — resurrecting it there would make it spendable
 * again outside the earliest-expiry ordering every other balance query assumes).
 */
export async function refundUsage(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: RefundUsageInput,
  deps?: EmitAbuseSignalDeps,
): Promise<RefundUsageResult> {
  if (!Number.isInteger(input.units) || input.units <= 0) {
    throw new FeatureBillingError('Refund units must be a positive integer', 'invalid_state')
  }
  if (!input.providerEvidenceReference.trim()) {
    throw new FeatureBillingError('Refund requires a provider-evidence reference', 'invalid_state')
  }

  const existingMarker = await findLedgerEntryByIdempotencyKey(transaction, principal.organizationId, input.idempotencyKey)
  if (existingMarker) {
    const reservation = await lockReservation(transaction, principal.organizationId, input.settlementId)
    if (!reservation) throw new FeatureBillingError('Reservation not found', 'invalid_state')
    return { reservation, refundedUnits: input.units }
  }

  const reservation = await lockReservation(transaction, principal.organizationId, input.settlementId)
  if (!reservation) throw new FeatureBillingError('Reservation not found', 'invalid_state')
  if (reservation.state !== 'settled') {
    throw new FeatureBillingError(`Reservation is ${reservation.state}, cannot refund usage that was never settled`, 'invalid_state')
  }
  if (reservation.settledUnits === null || input.units > reservation.settledUnits) {
    throw new FeatureBillingError(`Cannot refund ${input.units} units — only ${reservation.settledUnits ?? 0} were settled`, 'invalid_state')
  }

  // Refund-farming daily cap (Phase 4B "G4") — checked BEFORE refunding so a blocked attempt never
  // partially compensates. Only a real `enforce`-mode gate.
  const refundWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const refundedUnitsInWindow = await sumRefundedUnitsSince(transaction, principal.organizationId, refundWindowStart)
  if (
    env.ABUSE_ENFORCEMENT_MODE === 'enforce'
    && detectRefundCapExceeded({ refundedUnitsInWindow, thisRefundUnits: input.units, cap: env.CREDIT_REFUND_MAX_PER_DAY })
  ) {
    throw new FeatureBillingError('This organization has reached its daily refund cap', 'blocked')
  }

  const allocations = await listAllocationsForReservation(transaction, principal.organizationId, reservation.id)
  let remainingToRefund = input.units

  for (const allocation of allocations) {
    if (remainingToRefund <= 0) break
    const refundFromThis = Math.min(allocation.consumedUnits, remainingToRefund)
    if (refundFromThis <= 0) continue

    await updateAllocationConsumed(transaction, principal.organizationId, allocation.id, allocation.consumedUnits - refundFromThis)

    const grant = await findCreditGrant(transaction, principal.organizationId, allocation.grantId)
    const grantStillActive = grant && grant.state === 'active'
    if (grantStillActive) {
      await adjustCreditGrant(transaction, {
        organizationId: principal.organizationId,
        grantId: allocation.grantId,
        ledgerEntryId: `${input.idempotencyKey}-adjust-${allocation.grantId}`,
        idempotencyKey: `${input.idempotencyKey}-adjust-${allocation.grantId}`,
        unitsDelta: refundFromThis,
        reason: input.reason,
      })
    } else {
      await grantCredits(transaction, {
        grantId: `${input.idempotencyKey}-refund-grant-${allocation.grantId}`,
        ledgerEntryId: `${input.idempotencyKey}-refund-entry-${allocation.grantId}`,
        organizationId: principal.organizationId,
        source: 'promotional',
        sourceReference: `refund:${reservation.id}`,
        units: refundFromThis,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        idempotencyKey: `${input.idempotencyKey}-refund-${allocation.grantId}`,
      })
    }
    remainingToRefund -= refundFromThis
  }

  // `unitsDelta` records the total refunded here (not 0, like most other markers) — this is the
  // one entry `sumRefundedUnitsSince` reads to compute the daily cap/ratio without double-counting
  // the per-allocation `adjustCreditGrant` entries above, which never set `reservationId`.
  await insertLedgerEntry(transaction, {
    id: `${input.idempotencyKey}-marker`,
    organizationId: principal.organizationId,
    entryType: 'adjust',
    reservationId: reservation.id,
    unitsDelta: input.units,
    sourceIdempotencyKey: input.idempotencyKey,
    reason: input.reason,
  })

  // Refund-to-settle ratio signal (Phase 4B "G4") — always on (any enforcement mode), independent
  // of the daily-cap gate above: a low-and-slow farmer staying under the daily cap can still trip
  // this if enough of what they settle keeps coming back as a refund.
  const farmingWindowStart = new Date(Date.now() - env.CREDIT_REFUND_FARMING_WINDOW_HOURS * 60 * 60 * 1000)
  const [refundedUnitsInFarmingWindow, settledUnitsInFarmingWindow] = await Promise.all([
    sumRefundedUnitsSince(transaction, principal.organizationId, farmingWindowStart),
    sumSettledUnitsSince(transaction, principal.organizationId, farmingWindowStart),
  ])
  await checkRefundFarmingAndEmit(
    {
      refundedUnits: refundedUnitsInFarmingWindow,
      settledUnits: settledUnitsInFarmingWindow,
      ratioThreshold: env.CREDIT_REFUND_FARMING_RATIO_THRESHOLD,
      minSettledUnits: env.CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS,
      windowHours: env.CREDIT_REFUND_FARMING_WINDOW_HOURS,
    },
    { userId: principal.userId, organizationId: principal.organizationId, requestId: principal.requestId },
    deps,
  )

  return { reservation, refundedUnits: input.units }
}
