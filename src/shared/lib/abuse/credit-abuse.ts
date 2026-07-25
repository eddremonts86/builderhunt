import type { AnomalyEmitContext } from './anomalies'
import { emitAbuseSignal, type EmitAbuseSignalDeps } from './signals'

/**
 * Per-seat credit sub-budget + `pool_drain` signal (abuse-and-usage-integrity plan, Phase 4B "G2").
 * A Team's credit pool is shared across every seat — nothing here changes the pooled total or how
 * `reserveCredits`/`grantCredits` allocate against it (that stays entirely `stripe-billing-platform`'s
 * contract). This only asks: is one seat, on its own, consuming a disproportionate share of what the
 * whole org spent today? A single-seat org is never flagged — there is no one else's shared pool to
 * drain.
 */

export interface SeatShareInput {
  seatUnits: number
  poolTotalUnits: number
}

/** Fraction (0..1) of today's org-wide credit consumption this one seat accounts for. */
export function computeSeatShare(input: SeatShareInput): number {
  if (input.poolTotalUnits <= 0) return 0
  return input.seatUnits / input.poolTotalUnits
}

export interface PoolDrainInput {
  seatUnits: number
  cap: number
  seatCount: number
}

/**
 * True when this seat's own daily consumption exceeds its per-seat sub-cap, in an org with more
 * than one seat consuming credits today. `seatCount <= 1` never flags — a solo seat spending its
 * own org's pool isn't "draining" anything from anyone else.
 */
export function detectPoolDrain(input: PoolDrainInput): boolean {
  return input.seatCount > 1 && input.seatUnits > input.cap
}

export interface CheckPoolDrainInput extends PoolDrainInput {
  poolTotalUnits: number
}

/** Emits `pool_drain` if this seat's daily consumption exceeds its per-seat sub-cap. Detection only — the pooled total and every other seat's allocation are untouched. */
export async function checkPoolDrainAndEmit(
  input: CheckPoolDrainInput,
  context: AnomalyEmitContext,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const flagged = detectPoolDrain(input)
  if (flagged) {
    await emitAbuseSignal({
      type: 'pool_drain',
      severity: 'medium',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: {
        seatUnits: input.seatUnits,
        cap: input.cap,
        seatCount: input.seatCount,
        share: computeSeatShare({ seatUnits: input.seatUnits, poolTotalUnits: input.poolTotalUnits }),
      },
    }, deps)
  }
  return flagged
}

/**
 * First-payer credit-consumption cap + `credit_spend_velocity` signal (Phase 4B "G6"). A new
 * payment method being used to burn through granted credits fast is a classic stolen-card pattern
 * — by the time a chargeback lands, the provider cost is already spent. This never blocks a
 * purchase itself (that's `billing/risk.ts`'s payment-failure-velocity gate, already coordinating
 * with Stripe Radar/3DS) — it only caps how fast an org can *consume* credits shortly after its
 * first real payment.
 */

export interface FirstPayerWindowInput {
  /** The organization's earliest paid-source (pack/subscription) grant, or `null` if it has never paid. */
  firstPaidGrantAt: Date | null
  now: Date
  windowHours: number
}

/** True only while the org is still inside its first-payer window — `null` (never paid) never qualifies, and neither does an org whose first payment predates the window. */
export function isWithinFirstPayerWindow(input: FirstPayerWindowInput): boolean {
  if (!input.firstPaidGrantAt) return false
  const ageHours = (input.now.getTime() - input.firstPaidGrantAt.getTime()) / (1000 * 60 * 60)
  return ageHours >= 0 && ageHours < input.windowHours
}

export interface FirstPayerCapInput {
  /** Units already reserved in the window, BEFORE this reservation. */
  unitsReservedInWindow: number
  thisReservationUnits: number
  cap: number
}

/** True when adding this reservation would push the org's first-payer-window consumption over its cap. */
export function detectFirstPayerCapExceeded(input: FirstPayerCapInput): boolean {
  return input.unitsReservedInWindow + input.thisReservationUnits > input.cap
}

export interface CheckFirstPayerCapInput extends FirstPayerCapInput {
  windowHours: number
}

/** Emits `credit_spend_velocity` if this reservation would cross the first-payer cap. Detection only — call sites decide separately (via `ABUSE_ENFORCEMENT_MODE`) whether to actually block the reservation. */
export async function checkFirstPayerSpendVelocityAndEmit(
  input: CheckFirstPayerCapInput,
  context: AnomalyEmitContext,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const flagged = detectFirstPayerCapExceeded(input)
  if (flagged) {
    await emitAbuseSignal({
      type: 'credit_spend_velocity',
      severity: 'high',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: {
        unitsReservedInWindow: input.unitsReservedInWindow,
        thisReservationUnits: input.thisReservationUnits,
        cap: input.cap,
        windowHours: input.windowHours,
      },
    }, deps)
  }
  return flagged
}

/**
 * Refund-farming cap + `refund_farming` signal (Phase 4B "G4"). Two independent checks:
 * a hard daily cap on refunded units (`detectRefundCapExceeded`), and a ratio check
 * (`detectRefundFarming`) — repeatedly refunding a large share of what's actually settled is
 * suspicious even when each individual refund stayed under the daily cap.
 */

export interface RefundCapInput {
  /** Units already refunded in the rolling window, BEFORE this refund. */
  refundedUnitsInWindow: number
  thisRefundUnits: number
  cap: number
}

/** True when adding this refund would push the org's rolling refund total over its daily cap. */
export function detectRefundCapExceeded(input: RefundCapInput): boolean {
  return input.refundedUnitsInWindow + input.thisRefundUnits > input.cap
}

export interface RefundFarmingInput {
  refundedUnits: number
  settledUnits: number
  ratioThreshold: number
  /** Below this many settled units, the ratio is too noisy to mean anything — never flags a tiny sample. */
  minSettledUnits: number
}

/** True when the refund-to-settle ratio exceeds the threshold, with enough settled volume for the ratio to be meaningful. */
export function detectRefundFarming(input: RefundFarmingInput): boolean {
  if (input.settledUnits < input.minSettledUnits) return false
  return input.refundedUnits / input.settledUnits > input.ratioThreshold
}

export interface CheckRefundFarmingInput extends RefundFarmingInput {
  windowHours: number
}

/** Emits `refund_farming` if the refund-to-settle ratio crosses the threshold. Detection only — never blocks by itself (that's `detectRefundCapExceeded`'s job). */
export async function checkRefundFarmingAndEmit(
  input: CheckRefundFarmingInput,
  context: AnomalyEmitContext,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const flagged = detectRefundFarming(input)
  if (flagged) {
    await emitAbuseSignal({
      type: 'refund_farming',
      severity: 'high',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: {
        refundedUnits: input.refundedUnits,
        settledUnits: input.settledUnits,
        ratio: input.refundedUnits / input.settledUnits,
        ratioThreshold: input.ratioThreshold,
        windowHours: input.windowHours,
      },
    }, deps)
  }
  return flagged
}

/**
 * Promo/trial grant caps per identity cluster (Phase 4B "G1"). NOT WIRED TO PRODUCTION — same
 * reasoning as `margin.ts`: no production route mints a promotional or manual-trial grant today
 * (`grantCredits({source: 'promotional', ...})` is only ever called internally by
 * `feature-authorization.ts`'s `refundUsage` fallback, and `'operator_trial'` is never used at
 * all), and counting grants across every organization in a linked-account cluster (Phase 3's
 * `linked-accounts.ts`) would need its own new cross-organization RLS grant — out of proportion for
 * a feature with no live caller yet. Pure detection/signal logic only, ready for a future
 * promo/trial-issuing feature to call before minting, using whatever real grant-count query it
 * builds alongside its own RLS grant.
 */

export interface PromoGrantClusterCapInput {
  /** Promotional/manual-trial grants already minted across every organization in this identity cluster, BEFORE the grant being considered. */
  existingGrantsInCluster: number
  cap: number
}

/** True when minting one more promo/trial grant would push this cluster's total over its cap. */
export function detectPromoGrantClusterCapExceeded(input: PromoGrantClusterCapInput): boolean {
  return input.existingGrantsInCluster + 1 > input.cap
}

export interface CheckPromoGrantClusterCapInput extends PromoGrantClusterCapInput {
  clusterOrganizationIds: string[]
}

/** Emits `credit_farming` if minting would cross the per-cluster cap. Detection only — call sites decide separately (via `ABUSE_ENFORCEMENT_MODE`) whether to actually refuse the grant. */
export async function checkPromoGrantClusterCapAndEmit(
  input: CheckPromoGrantClusterCapInput,
  context: AnomalyEmitContext,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const flagged = detectPromoGrantClusterCapExceeded(input)
  if (flagged) {
    await emitAbuseSignal({
      type: 'credit_farming',
      severity: 'high',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: {
        existingGrantsInCluster: input.existingGrantsInCluster,
        cap: input.cap,
        clusterOrganizationIds: input.clusterOrganizationIds,
      },
    }, deps)
  }
  return flagged
}
