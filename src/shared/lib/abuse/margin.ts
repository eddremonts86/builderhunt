import type { MinimaxUsage } from '../ai/minimax'
import type { AnomalyEmitContext } from './anomalies'
import { emitAbuseSignal, type EmitAbuseSignalDeps } from './signals'

/**
 * Provider cost-vs-credit margin monitor (abuse-and-usage-integrity plan, Phase 4B "G7").
 *
 * NOT WIRED TO PRODUCTION. Every current server-side `minimaxChat` call site
 * (`semantic-search.ts`, `enrichment.ts`, `/api/ai/complete`) uses the call-count
 * `checkAndConsumeBudget` budget, not the dollar-based credit ledger
 * (`billing/feature-authorization.ts`'s `reserveCredits`) — and `reserveCredits` itself is not
 * called from any production route today (confirmed by repo-wide search). So there is no live
 * "settled op with credits actually charged" to compare a provider cost against yet. This module
 * is the pure, tested detection logic — ready to wire in once a real feature reserves/settles
 * credits for an AI call — not a live monitor. `ai/minimax.ts`'s `onUsage` observer captures the
 * token-usage half of the equation in the meantime.
 *
 * The per-token cost constants in `env.ts` are explicitly documented placeholders, not confirmed
 * MiniMax pricing — update them before relying on this for anything beyond its own tests.
 */

export interface EstimateProviderCostInput {
  usage: MinimaxUsage
  costPerThousandInputTokensCents: number
  costPerThousandOutputTokensCents: number
}

/** Estimated provider cost in cents for one usage sample. */
export function estimateProviderCostCents(input: EstimateProviderCostInput): number {
  const inputCost = (input.usage.promptTokens / 1000) * input.costPerThousandInputTokensCents
  const outputCost = (input.usage.completionTokens / 1000) * input.costPerThousandOutputTokensCents
  return inputCost + outputCost
}

export interface MarginDriftInput {
  providerCostCents: number
  creditsChargedCents: number
  ratioThreshold: number
}

/**
 * True when provider cost exceeds what was charged by more than `ratioThreshold` allows — e.g. a
 * `ratioThreshold` of 1 flags as soon as cost exceeds revenue; 1.2 tolerates up to 20% overrun
 * before flagging. `creditsChargedCents <= 0` never flags (nothing was charged — a rate-card or
 * entitlement bug, not a margin problem this monitor is meant to catch).
 */
export function detectMarginDrift(input: MarginDriftInput): boolean {
  if (input.creditsChargedCents <= 0) return false
  return input.providerCostCents / input.creditsChargedCents > input.ratioThreshold
}

export interface CheckMarginDriftInput extends MarginDriftInput {
  operation: string
}

/** Emits `margin_drift` if the cost-to-revenue ratio crosses the threshold. Alert only — never blocks anything by itself. */
export async function checkMarginDriftAndEmit(
  input: CheckMarginDriftInput,
  context: AnomalyEmitContext,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const flagged = detectMarginDrift(input)
  if (flagged) {
    await emitAbuseSignal({
      type: 'margin_drift',
      severity: 'medium',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: {
        operation: input.operation,
        providerCostCents: input.providerCostCents,
        creditsChargedCents: input.creditsChargedCents,
        ratio: input.providerCostCents / input.creditsChargedCents,
        ratioThreshold: input.ratioThreshold,
      },
    }, deps)
  }
  return flagged
}
