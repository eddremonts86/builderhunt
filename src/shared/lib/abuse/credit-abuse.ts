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
