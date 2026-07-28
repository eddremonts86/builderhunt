/**
 * Interview-specific usage estimation arithmetic (plan: calendar-scheduling-interview-
 * intelligence, spec.md "Usage credits and pricing" + "Enforcement"). Pure — no I/O, no
 * reservation/ledger state of its own. This module only computes numbers; the actual
 * reserve/extend/heartbeat/settle/release/refund authority stays entirely with the billing
 * platform's own contracts (`shared/lib/billing/reservations.ts`, `credits.ts`) — this file must
 * never define a local grant or reservation state machine.
 */
import { INTERVIEW_RATE_CARD_KEYS, LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_FRACTIONS, LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_MINUTES_REMAINING } from '~/shared/lib/interview-config'

export class InterviewBillingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'InterviewBillingError'
  }
}

/** Rounds up to the next whole minute — a partial minute of provider-billed transcription still costs a full minute's credit, matching the platform's integer-unit ledger. */
export function estimateTranscriptionUnitsForSeconds(providerBilledSeconds: number): number {
  if (!Number.isFinite(providerBilledSeconds) || providerBilledSeconds < 0) {
    throw new InterviewBillingError('providerBilledSeconds must be a non-negative finite number', 'invalid_input')
  }
  const minutes = Math.ceil(providerBilledSeconds / 60)
  return minutes * INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units
}

export function estimateBriefUnits(): number {
  return INTERVIEW_RATE_CARD_KEYS.brief.units
}

export function estimateReportUnits(): number {
  return INTERVIEW_RATE_CARD_KEYS.report.units
}

/**
 * A single interview reservation's local sanity ceiling (this module's own bound, not yet
 * registered with the billing platform's `RATE_CARDS` map — a separate later task). Three hours
 * is a generous ceiling for one live interview session; it exists to prevent a runaway or
 * never-settled reservation, not to model a real product limit.
 */
export const MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES = 180

export function maxLiveTranscriptionReservationUnits(): number {
  return MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES * INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units
}

/** Throws if a requested reservation would exceed the local sanity ceiling. */
export function assertWithinMaxReservation(requestedUnits: number): void {
  const max = maxLiveTranscriptionReservationUnits()
  if (requestedUnits > max) {
    throw new InterviewBillingError(`Requested ${requestedUnits} units exceeds the maximum single-session reservation of ${max} units`, 'reservation_too_large')
  }
}

export type LowBalanceWarningLevel = 'eighty_percent' | 'ninety_percent' | 'ten_minutes_remaining'

export interface LowBalanceWarning {
  level: LowBalanceWarningLevel
  remainingUnits: number
}

/** spec.md "Enforcement": "warn at 80%, 90%, and ten remaining minutes." A session past both percentage thresholds AND under the remaining-minutes floor returns every warning that applies, not just the most severe one — callers decide how to render multiple simultaneous warnings. */
export function resolveLowBalanceWarnings(params: { reservedUnits: number; consumedUnits: number }): LowBalanceWarning[] {
  const { reservedUnits, consumedUnits } = params
  if (!Number.isFinite(reservedUnits) || reservedUnits <= 0) {
    throw new InterviewBillingError('reservedUnits must be a positive finite number', 'invalid_input')
  }
  if (!Number.isFinite(consumedUnits) || consumedUnits < 0) {
    throw new InterviewBillingError('consumedUnits must be a non-negative finite number', 'invalid_input')
  }

  const remainingUnits = Math.max(0, reservedUnits - consumedUnits)
  const consumedFraction = consumedUnits / reservedUnits
  const warnings: LowBalanceWarning[] = []

  const [eightyFraction, ninetyFraction] = LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_FRACTIONS
  if (consumedFraction >= eightyFraction) warnings.push({ level: 'eighty_percent', remainingUnits })
  if (consumedFraction >= ninetyFraction) warnings.push({ level: 'ninety_percent', remainingUnits })

  const remainingMinutes = remainingUnits / INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units
  if (remainingMinutes <= LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_MINUTES_REMAINING) {
    warnings.push({ level: 'ten_minutes_remaining', remainingUnits })
  }

  return warnings
}

// ── Provider-usage normalization (spec.md: "Provider records reconcile duration/tokens/cost; variance must remain below 1%.") ─

export interface ProviderUsageVariance {
  estimatedUnits: number
  actualUnits: number
  varianceRatio: number
  withinTolerance: boolean
}

const MAX_ACCEPTABLE_VARIANCE_RATIO = 0.01

/** Normalizes a provider's raw billed-seconds figure to integer credit units and compares it against the estimate that authorized the reservation. */
export function normalizeProviderUsageVariance(params: { providerBilledSeconds: number; estimatedUnits: number }): ProviderUsageVariance {
  const { providerBilledSeconds, estimatedUnits } = params
  if (!Number.isFinite(estimatedUnits) || estimatedUnits < 0) {
    throw new InterviewBillingError('estimatedUnits must be a non-negative finite number', 'invalid_input')
  }
  const actualUnits = estimateTranscriptionUnitsForSeconds(providerBilledSeconds)
  const varianceRatio = estimatedUnits === 0 ? (actualUnits === 0 ? 0 : 1) : Math.abs(actualUnits - estimatedUnits) / estimatedUnits
  return {
    estimatedUnits,
    actualUnits,
    varianceRatio,
    withinTolerance: varianceRatio < MAX_ACCEPTABLE_VARIANCE_RATIO,
  }
}

// ── Reserve-and-settle wrapper (plan Phase 7: "Wrap every interview provider boundary in reserve
//    and settlement") ─────────────────────────────────────────────────────────────────────────────

import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import {
  FeatureBillingError,
  checkEntitlement,
  extendReservation,
  releaseReservation,
  reserveCredits,
  settleReservation,
} from '~/shared/lib/billing/feature-authorization'
import { getInterviewRateCardKey, type InterviewRateCardOperation } from '~/shared/lib/interview-config'

/**
 * What the provider-backed work is handed. Everything it needs to stay inside the budget that was
 * approved, and nothing that would let it approve more on its own.
 */
export interface InterviewCreditContext {
  reservationId: string
  /** The ceiling this reservation currently covers. Grows only through `extend`. */
  maximumUnits: number
  /**
   * Asks the platform for more budget mid-flight, for work whose length is not known up front.
   *
   * Throws `FeatureBillingError('insufficient_credits')` when refused, and the caller **must stop
   * the provider work immediately** — continuing would consume credits nobody authorized. That is
   * why this returns the new ceiling rather than a boolean: there is no "false" branch a caller
   * could accidentally ignore.
   */
  extend(additionalUnits: number): Promise<number>
}

export interface InterviewWorkOutcome<TResult> {
  result: TResult
  /** What the provider actually billed, in credit units. Settled as-is; never rounded up to the reservation. */
  actualUnits: number
  /** The provider's own reference for this usage, for reconciliation. Null only when the provider returned none. */
  providerReference: string | null
}

/**
 * Runs one provider-backed interview operation inside a credit reservation.
 *
 * The ordering is the point, and it is not negotiable:
 *
 *   1. entitlement, 2. reserve, 3. **then** the provider, 4. settle actual use — or release on failure.
 *
 * `work` is only ever invoked after step 2 returns. A version that reserved and called the provider
 * concurrently to save a round trip would spend real provider money on a request the tier or the
 * balance was about to refuse, and the refusal would arrive too late to matter.
 *
 * ## Failure releases rather than settles
 *
 * A provider that threw consumed nothing we can account for, so the full hold goes back. Settling a
 * failure at its reserved amount would charge a candidate's interview for output nobody received;
 * settling it at zero would leave a settled-but-empty reservation that reconciliation cannot tell
 * apart from a genuinely free operation.
 *
 * If the release itself fails, the original provider error is what propagates — a caller debugging a
 * failed brief needs the provider's reason, not a bookkeeping error that happened afterwards. The
 * stranded reservation expires through the platform's own grace window.
 *
 * ## The release only matters if the caller does not roll back
 *
 * Everything here runs inside the caller's `transaction`. A route that lets the error escape its own
 * transaction rolls the reservation back wholesale, and the release becomes moot — there is no row
 * left to release. The release exists for the caller that *catches*: a session worker that fails one
 * interview and commits the rest of its bookkeeping would otherwise leave a hold standing until the
 * grace window expired. Both behaviours are correct; which one applies is the caller's choice of
 * transaction boundary, not something this function can decide.
 */
export async function withInterviewCredits<TResult>(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: {
    operation: InterviewRateCardOperation
    reservationId: string
    idempotencyKey: string
  },
  work: (context: InterviewCreditContext) => Promise<InterviewWorkOutcome<TResult>>,
): Promise<{ result: TResult; settledUnits: number; providerReference: string | null }> {
  const card = getInterviewRateCardKey(input.operation)

  // Checked before reserving, so a tier that cannot use this feature never creates a reservation row
  // it will immediately have to release.
  const entitlement = await checkEntitlement(transaction, principal, { feature: card.operationKey })
  if (!entitlement.allowed) {
    throw new FeatureBillingError(
      `Not entitled to ${card.operationKey}: ${entitlement.reason}`,
      'insufficient_entitlement',
    )
  }

  const reserved = await reserveCredits(transaction, principal, {
    reservationId: input.reservationId,
    operation: card.operationKey,
    idempotencyKey: input.idempotencyKey,
  })

  let maximumUnits = reserved.reservation.maximumUnits
  let extensions = 0

  const context: InterviewCreditContext = {
    reservationId: input.reservationId,
    get maximumUnits() {
      return maximumUnits
    },
    async extend(additionalUnits: number) {
      if (!Number.isInteger(additionalUnits) || additionalUnits <= 0) {
        throw new InterviewBillingError('additionalUnits must be a positive integer', 'invalid_input')
      }
      extensions += 1
      const extended = await extendReservation(transaction, principal, {
        reservationId: input.reservationId,
        additionalMaximumUnits: additionalUnits,
        // Derived from the extension count, so a retried extension replays instead of stacking a
        // second grant on top of the first.
        idempotencyKey: `${input.idempotencyKey}:extend:${extensions}`,
      })
      maximumUnits = extended.reservation.maximumUnits
      return maximumUnits
    },
  }

  let outcome: InterviewWorkOutcome<TResult>
  try {
    outcome = await work(context)
  } catch (error) {
    await releaseReservation(transaction, principal, {
      reservationId: input.reservationId,
      reason: 'provider_failed',
      idempotencyKey: `${input.idempotencyKey}:release`,
    }).catch(() => undefined)
    throw error
  }

  if (!Number.isInteger(outcome.actualUnits) || outcome.actualUnits < 0) {
    throw new InterviewBillingError('actualUnits must be a non-negative integer', 'invalid_input')
  }
  // Clamped rather than trusted. The platform would reject an over-reservation settlement anyway, but
  // failing here names the cause — a provider that reported more than the reservation covered means
  // the extension logic above did not keep up, which is a bug in this module's caller, not a billing
  // error.
  if (outcome.actualUnits > maximumUnits) {
    throw new InterviewBillingError(
      `Provider reported ${outcome.actualUnits} units against a reservation of ${maximumUnits}; the work should have extended it`,
      'settlement_exceeds_reservation',
    )
  }

  const settled = await settleReservation(transaction, principal, {
    reservationId: input.reservationId,
    actualUnits: outcome.actualUnits,
    idempotencyKey: `${input.idempotencyKey}:settle`,
  })

  return {
    result: outcome.result,
    settledUnits: settled.reservation.settledUnits ?? outcome.actualUnits,
    providerReference: outcome.providerReference,
  }
}

/**
 * Contextual questions are included in an active paid transcription, so they reserve nothing — but
 * they are still gated, and the gate is *two* conditions.
 *
 * spec.md: "Contextual questions: included during active paid transcription." Tier alone is not
 * enough: a Pro organization with no live session must not be able to drive the question endpoint as
 * a free general-purpose model. The caller supplies whether a paid transcription reservation is
 * currently live, because only it can know.
 */
export async function authorizeContextualQuestion(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: { transcriptionReservationActive: boolean },
): Promise<void> {
  const card = getInterviewRateCardKey('contextualQuestion')
  const entitlement = await checkEntitlement(transaction, principal, { feature: card.operationKey })
  if (!entitlement.allowed) {
    throw new FeatureBillingError(
      `Not entitled to ${card.operationKey}: ${entitlement.reason}`,
      'insufficient_entitlement',
    )
  }
  if (!input.transcriptionReservationActive) {
    throw new InterviewBillingError(
      'Contextual questions are included only during active paid transcription',
      'transcription_not_active',
    )
  }
}
