import { estimateTranscriptionUnitsForSeconds } from '~/modules/interviews/billing-shared'
import { refundUsage } from '~/shared/lib/billing/feature-authorization'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'

/**
 * Reconciles what a provider says it billed against what the platform settled (plan:
 * calendar-scheduling-interview-intelligence, Phase 11).
 *
 * ## This module compares and requests. It never writes the ledger.
 *
 * Every correction goes through the platform's own `refundUsage`, which makes the ledger entries, requires
 * provider evidence, and refuses a refund larger than what was consumed. Reimplementing any of that here
 * would be a second billing path that agrees with the first until the day it does not.
 *
 * And it only ever refunds. There is no code path that debits more after a settlement closed: a customer who
 * was under-charged because a provider reported late has already been told what the interview cost, and
 * reaching back into a closed period to take more is the one thing an accounting system must not do quietly.
 * An under-billing is *reported* as a variance for a human to decide about.
 *
 * ## Rounding is not a variance
 *
 * Transcription bills whole minutes and Deepgram reports fractional seconds, so a 1,801-second call settles
 * at 31 units against a provider figure of 30.02 minutes. Treating that as a discrepancy would make every
 * single interview a discrepancy and the report worthless. `classifyUsage` separates the rounding band from a
 * real difference, and the threshold is the rate card's own unit, not a percentage.
 */

export type UsageOutcome =
  | 'matched'
  | 'rounding'
  | 'variance_within_policy'
  | 'variance_above_policy'
  | 'missing_provider'
  | 'missing_settlement'
  | 'duplicate_provider'

export interface ProviderUsageRecord {
  /** Deepgram's `request_id`, or the provider's own identifier. The join key. */
  providerReference: string
  /** Seconds for transcription; tokens for a text task. Normalized by `normalizeProviderUsage`. */
  billedSeconds?: number
  promptTokens?: number
  completionTokens?: number
  /** When the provider says it happened, so a late report is distinguishable from a missing one. */
  occurredAt: Date
}

export interface SettlementRecord {
  reservationId: string
  operation: string
  providerReference: string | null
  settledUnits: number
  settledAt: Date
}

export interface UsageComparison {
  outcome: UsageOutcome
  reservationId: string | null
  providerReference: string
  settledUnits: number
  providerUnits: number
  /** Positive means the platform billed more than the provider did. */
  differenceUnits: number
  detail: string
}

/**
 * Variance beyond this fraction is escalated rather than absorbed.
 *
 * One percent, matching the reconciliation policy already in the plan. Below it, a difference is noise from
 * rounding and clock skew and is reported without action; above it, something is wrong with the metering and
 * a human decides.
 */
export const USAGE_VARIANCE_POLICY_FRACTION = 0.01

/**
 * Turns a provider record into rate-card units.
 *
 * Transcription rounds **up** to the whole minute, because that is what the rate card charges and what
 * `estimateTranscriptionUnitsForSeconds` already does — using a different rounding here would manufacture a
 * variance on every interview.
 *
 * A text task reports tokens, which the rate card does not price: brief and report are flat 5 units each. So
 * tokens are carried for the record and contribute zero units, and a comparison for those operations is about
 * whether the call happened, not how large it was.
 */
export function normalizeProviderUsage(
  record: ProviderUsageRecord,
  operation: string,
): { units: number; basis: 'seconds' | 'tokens' | 'flat' } {
  if (operation === 'interview_live_transcription') {
    return { units: estimateTranscriptionUnitsForSeconds(record.billedSeconds ?? 0), basis: 'seconds' }
  }
  if (record.promptTokens !== undefined || record.completionTokens !== undefined) {
    // Flat-priced, so the token count is evidence rather than a quantity to bill.
    return { units: 5, basis: 'tokens' }
  }
  return { units: 5, basis: 'flat' }
}

/**
 * Compares one settlement against the provider's own figure.
 *
 * `settledUnits` of zero with a provider figure above zero is `missing_settlement`, not a variance: the
 * platform released the hold and the provider billed anyway, which is a metering failure rather than an
 * arithmetic one.
 */
export function classifyUsage(params: {
  settlement: SettlementRecord
  provider: ProviderUsageRecord | null
  duplicateProviderReferences?: ReadonlySet<string>
}): UsageComparison {
  const { settlement, provider } = params
  const reference = settlement.providerReference ?? provider?.providerReference ?? '(none)'

  if (params.duplicateProviderReferences?.has(reference)) {
    return {
      outcome: 'duplicate_provider',
      reservationId: settlement.reservationId,
      providerReference: reference,
      settledUnits: settlement.settledUnits,
      providerUnits: 0,
      differenceUnits: 0,
      // Not summed. Two provider records for one reference could be a genuine retry or a double-report, and
      // adding them would bill a customer for the provider's own ambiguity.
      detail: 'the provider export lists this reference more than once; not reconciled',
    }
  }

  if (!provider) {
    return {
      outcome: 'missing_provider',
      reservationId: settlement.reservationId,
      providerReference: reference,
      settledUnits: settlement.settledUnits,
      providerUnits: 0,
      differenceUnits: settlement.settledUnits,
      detail: settlement.settledUnits > 0
        ? 'settled units with no provider record — possibly a late export'
        : 'released with no provider record, which is the expected pair',
    }
  }

  const { units: providerUnits, basis } = normalizeProviderUsage(provider, settlement.operation)
  const difference = settlement.settledUnits - providerUnits

  if (settlement.settledUnits === 0 && providerUnits > 0) {
    return {
      outcome: 'missing_settlement',
      reservationId: settlement.reservationId,
      providerReference: reference,
      settledUnits: 0,
      providerUnits,
      differenceUnits: -providerUnits,
      detail: 'the provider billed for work the platform did not settle',
    }
  }

  if (difference === 0) {
    return {
      outcome: 'matched',
      reservationId: settlement.reservationId,
      providerReference: reference,
      settledUnits: settlement.settledUnits,
      providerUnits,
      differenceUnits: 0,
      detail: 'exact',
    }
  }

  // One unit on a seconds-based operation is the rounding the rate card itself performs. Calling that a
  // variance would make every interview one.
  if (basis === 'seconds' && Math.abs(difference) <= 1) {
    return {
      outcome: 'rounding',
      reservationId: settlement.reservationId,
      providerReference: reference,
      settledUnits: settlement.settledUnits,
      providerUnits,
      differenceUnits: difference,
      detail: 'within the rate card’s own whole-minute rounding',
    }
  }

  const fraction = providerUnits === 0 ? 1 : Math.abs(difference) / providerUnits
  return {
    outcome: fraction > USAGE_VARIANCE_POLICY_FRACTION ? 'variance_above_policy' : 'variance_within_policy',
    reservationId: settlement.reservationId,
    providerReference: reference,
    settledUnits: settlement.settledUnits,
    providerUnits,
    differenceUnits: difference,
    detail: `${(fraction * 100).toFixed(2)}% ${difference > 0 ? 'over' : 'under'} the provider figure`,
  }
}

export interface ReconcileUsageResult {
  comparisons: UsageComparison[]
  counts: Record<UsageOutcome, number>
  /** Provider records with no settlement at all — the export's own orphans. */
  unmatchedProviderReferences: string[]
  refundsRequested: Array<{ reservationId: string; units: number }>
}

/**
 * Reconciles a provider export against a set of settlements.
 *
 * Pure except for the refund requests, which go through the platform. Taking both sides as arguments is what
 * makes every band above testable against a fixture instead of against a seeded month of traffic.
 */
export async function reconcileInterviewUsage(
  params: {
    settlements: readonly SettlementRecord[]
    providerRecords: readonly ProviderUsageRecord[]
    /** Present only when a refund is to be requested. Omit for a report-only run. */
    refund?: {
      transaction: TenantTransaction
      principal: TenantPrincipal
      /** Maps a reservation to the settlement id `refundUsage` needs. */
      settlementIdFor: (reservationId: string) => string | null
    }
  },
): Promise<ReconcileUsageResult> {
  const byReference = new Map<string, ProviderUsageRecord>()
  const duplicates = new Set<string>()
  for (const record of params.providerRecords) {
    if (byReference.has(record.providerReference)) duplicates.add(record.providerReference)
    else byReference.set(record.providerReference, record)
  }

  const comparisons = params.settlements.map((settlement) => classifyUsage({
    settlement,
    provider: settlement.providerReference ? byReference.get(settlement.providerReference) ?? null : null,
    duplicateProviderReferences: duplicates,
  }))

  const counts = {
    matched: 0, rounding: 0, variance_within_policy: 0, variance_above_policy: 0,
    missing_provider: 0, missing_settlement: 0, duplicate_provider: 0,
  } satisfies Record<UsageOutcome, number>
  for (const comparison of comparisons) counts[comparison.outcome] += 1

  const settledReferences = new Set(
    params.settlements.map((settlement) => settlement.providerReference).filter((reference): reference is string => reference !== null),
  )
  const unmatchedProviderReferences = [...byReference.keys()].filter((reference) => !settledReferences.has(reference))

  const refundsRequested: ReconcileUsageResult['refundsRequested'] = []
  if (params.refund) {
    for (const comparison of comparisons) {
      // Over-billing only, and only above policy. An under-billing is reported and never chased: the customer
      // has been told what the interview cost, and taking more from a closed period is not a correction.
      if (comparison.outcome !== 'variance_above_policy' || comparison.differenceUnits <= 0) continue
      if (!comparison.reservationId) continue
      const settlementId = params.refund.settlementIdFor(comparison.reservationId)
      if (!settlementId) continue

      await refundUsage(params.refund.transaction, params.refund.principal, {
        settlementId,
        units: comparison.differenceUnits,
        reason: 'provider_usage_variance',
        // Required by the platform: a usage refund is never accepted on our say-so alone. The provider's own
        // reference is the evidence.
        providerEvidenceReference: comparison.providerReference,
        // Deterministic, so a re-run of the same reconciliation replays instead of refunding twice.
        idempotencyKey: `usage-reconciliation:${comparison.reservationId}:${comparison.differenceUnits}`,
      })
      refundsRequested.push({ reservationId: comparison.reservationId, units: comparison.differenceUnits })
    }
  }

  return { comparisons, counts, unmatchedProviderReferences, refundsRequested }
}

/**
 * Maps this module's outcomes onto the platform's mismatch vocabulary.
 *
 * The billing reconciliation contract already has a shape for reporting a discrepancy, and inventing a second
 * one would mean two dashboards that disagree. `matched` and `rounding` are absent on purpose: they are not
 * mismatches and reporting them would bury the ones that are.
 */
export function toReconciliationMismatchType(outcome: UsageOutcome):
  'missing_internal' | 'extra_internal' | 'stale_internal' | 'duplicate_provider_listing' | null {
  switch (outcome) {
    case 'missing_settlement': return 'missing_internal'
    case 'missing_provider': return 'extra_internal'
    case 'variance_above_policy': return 'stale_internal'
    case 'duplicate_provider': return 'duplicate_provider_listing'
    default: return null
  }
}
