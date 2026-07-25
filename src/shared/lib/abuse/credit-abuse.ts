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
