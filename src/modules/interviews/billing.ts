/**
 * The interview credit boundary: reserve, extend, settle, release (plan:
 * calendar-scheduling-interview-intelligence, spec.md "Enforcement").
 *
 * **Server-only.** It imports `feature-authorization`, which reaches the tenant repositories and the
 * `postgres` driver, so a component that imported this file would break the entire client bundle —
 * `postgres` calls `Buffer.allocUnsafe` at module scope and the browser throws before any app code runs.
 * That happened. The pure arithmetic a component legitimately needs lives in `billing-shared.ts`, and the
 * re-exports below exist so server callers still have one import site.
 */
import {
  checkEntitlement,
  extendReservation,
  FeatureBillingError,
  releaseReservation,
  reserveCredits,
  settleReservation,
} from '~/shared/lib/billing/feature-authorization'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { getInterviewRateCardKey, type InterviewRateCardOperation } from '~/shared/lib/interview-config'
import { InterviewBillingError } from './billing-shared'

// Re-exported so server code keeps a single import site and the split stays invisible to it.
export * from './billing-shared'

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
