/**
 * The Solutions credit boundary: entitle, confirm, reserve, run, settle or release (plan 43 Phase 6,
 * "Add entitlement and reservation orchestration").
 *
 * **Server-only.** It reaches `feature-authorization`, which reaches the tenant repositories and the
 * `postgres` driver. A component importing this file breaks the entire client bundle — `postgres` calls
 * `Buffer.allocUnsafe` at module scope and the browser throws before any application code runs. That has
 * already happened twice in this repository.
 *
 * ## The ordering, which is the whole point
 *
 *   1. flag, 2. entitlement, 3. **explicit confirmation of the displayed charge**, 4. reserve,
 *   5. then the provider, 6. settle the fixed price — or release.
 *
 * `work` is only ever invoked after step 4 returns. A version that reserved and called the provider
 * concurrently to save a round trip would spend real provider money on a request the tier or the balance was
 * about to refuse, and the refusal would arrive too late to matter.
 *
 * ## The charge is fixed, and that shapes everything below
 *
 * spec.md's premium contract: "`solutions.generate.v1`: fixed 10-credit settlement after a usable result" and
 * "`solutions.regenerate.v1`: fixed 3-credit settlement when the rerun invokes providers". So the caller does
 * not report provider usage and this module does not meter anything. What the caller reports is the two facts
 * the price depends on — was the result usable, and did any provider run — and the settlement follows from
 * them.
 *
 * An earlier draft metered provider units and settled what it was told, which would have charged two users
 * different amounts for the same product because one brief needed a clarification round. It also made the
 * confirmation prompt a lie: a "maximum" is not what spec.md promises to show, a price is.
 *
 * There is deliberately no `extend`: a fixed price has nothing to extend to, and the reservation already
 * covers the entire charge from the moment it is created.
 */
import {
  checkEntitlement,
  FeatureBillingError,
  releaseReservation,
  reserveCredits,
  settleReservation,
} from '~/shared/lib/billing/feature-authorization'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { getSolutionsFeatureFlags, getSolutionsRateCardKey, type SolutionsRateCardOperation } from '~/shared/lib/solutions/config'
import { log } from '~/shared/lib/log'

export class SolutionsBillingError extends Error {
  constructor(
    message: string,
    public code:
      | 'feature_disabled'
      | 'confirmation_required'
      | 'confirmed_amount_stale',
  ) {
    super(message)
    this.name = 'SolutionsBillingError'
  }
}

export interface SolutionsWorkOutcome<TResult> {
  result: TResult
  /**
   * Whether the result is usable by the person who asked for it.
   *
   * The only thing that decides settle-versus-release, and spec.md words it that way on purpose: "release on
   * abandonment or when no usable result is produced". A run that produced two offerable routes and failed to
   * explain the third is usable — the user has advice, and charging for it is correct. A run that produced only
   * `unavailable` routes because the provider died is not: it is technically a completed computation and
   * practically nothing, so the hold goes back.
   *
   * This is not the same as "the provider threw". A degraded provider that answers with unusable content never
   * raises, so a catch-based boundary would charge full price for it.
   */
  usable: boolean
  /**
   * Whether any provider call actually ran.
   *
   * Only affects `regenerate`, whose price spec.md conditions on it: a rerun that answered from the stored
   * interpretation and the catalog alone settles nothing. `generate` is charged either way — its price covers
   * the whole operation, and a brief the deterministic composer could answer outright is not a cheaper product,
   * it is the same product delivered more efficiently.
   */
  providerInvoked: boolean
  /** The provider's own id for the run, so a disputed charge traces to their invoice rather than to our guess. */
  providerReference: string | null
}

export interface SolutionsCreditConfirmation {
  /** The charge the user was shown, in credit units. */
  acceptedUnits: number
  /** The rate-card version that charge came from. A version bump invalidates a stale confirmation. */
  acceptedRateCardVersion: number
}

export interface SolutionsChargeOutcome<TResult> {
  result: TResult
  settledUnits: number
  providerReference: string | null
  released: boolean
}

/**
 * Runs one Solutions operation inside a credit reservation and charges the fixed price for it.
 *
 * ## Failure releases rather than settles
 *
 * A run that threw produced nothing the user can act on, so the full hold goes back. Settling the price would
 * charge for output nobody received; settling zero would leave a settled-but-empty reservation that
 * reconciliation cannot tell apart from a rerun that legitimately needed no provider.
 *
 * If the release itself fails, the original error is what propagates — someone debugging a failed brief needs
 * the provider's reason, not a bookkeeping error that happened afterwards. The stranded hold expires through
 * the platform's grace window.
 *
 * ## The release only matters if the caller does not roll back
 *
 * Everything here runs inside the caller's `transaction`. A route that lets the error escape its own
 * transaction rolls the reservation back wholesale and the release is moot — there is no row left to release.
 * The release exists for the caller that *catches*: a worker processing a batch of briefs that fails one and
 * commits the rest would otherwise leave a hold standing until the grace window expired. Both behaviours are
 * correct, and both are asserted in `tests/unit/modules/solutions/billing.test.ts`; which applies is the
 * caller's choice of transaction boundary.
 */
export async function withSolutionsCredits<TResult>(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: {
    operation: SolutionsRateCardOperation
    reservationId: string
    /**
     * Reused verbatim on a retry, which is what makes a duplicate request replay instead of double-charging.
     * The platform derives the settle/release keys from it, so one key covers the whole lifecycle.
     */
    idempotencyKey: string
    confirmation: SolutionsCreditConfirmation
  },
  work: () => Promise<SolutionsWorkOutcome<TResult>>,
): Promise<SolutionsChargeOutcome<TResult>> {
  const card = getSolutionsRateCardKey(input.operation)

  // The flag first, before any billing state is touched. A disabled feature must not create a reservation it
  // then has to release, and it must not report itself as an entitlement problem — a user on the right tier
  // being told they lack entitlement, when the truth is the feature is off, sends them to buy an upgrade that
  // changes nothing.
  if (!getSolutionsFeatureFlags().paidGenerationEnabled) {
    throw new SolutionsBillingError('Paid Solutions generation is disabled', 'feature_disabled')
  }

  /**
   * The confirmation gate, before entitlement and before reserving — spec.md: "Show the maximum charge before
   * confirmation; reserve before interpretation or other provider access".
   *
   * Checked against the *current* rate card rather than the one the client sent, so a client that cached a
   * cheaper price cannot bill at it, and a client that cached a dearer one is not overcharged either. Both are
   * refused and asked to re-confirm against what the card says now.
   */
  if (!Number.isInteger(input.confirmation.acceptedUnits) || input.confirmation.acceptedUnits <= 0) {
    throw new SolutionsBillingError('A confirmed charge is required before any provider work', 'confirmation_required')
  }
  if (input.confirmation.acceptedRateCardVersion !== card.version || input.confirmation.acceptedUnits !== card.units) {
    throw new SolutionsBillingError(
      `Confirmation was for ${input.confirmation.acceptedUnits} credits at rate-card version `
      + `${input.confirmation.acceptedRateCardVersion}; the current card is ${card.units} credits at version ${card.version}`,
      'confirmed_amount_stale',
    )
  }

  // Before reserving, so a tier that cannot use this feature never creates a row it immediately releases.
  const entitlement = await checkEntitlement(transaction, principal, { feature: card.operationKey })
  if (!entitlement.allowed) {
    throw new FeatureBillingError(`Not entitled to ${card.operationKey}: ${entitlement.reason}`, 'insufficient_entitlement')
  }

  await reserveCredits(transaction, principal, {
    reservationId: input.reservationId,
    operation: card.operationKey,
    idempotencyKey: input.idempotencyKey,
  })

  let outcome: SolutionsWorkOutcome<TResult>
  try {
    outcome = await work()
  } catch (error) {
    await release(transaction, principal, input, 'operation_failed')
    throw error
  }

  if (!outcome.usable) {
    await release(transaction, principal, input, 'unusable_result')
    log.info('solutions_credits_released_unusable', {
      operation: card.operationKey, reservationId: input.reservationId, providerInvoked: outcome.providerInvoked,
    })
    return { result: outcome.result, settledUnits: 0, providerReference: outcome.providerReference, released: true }
  }

  /**
   * The one place the price is decided.
   *
   * `regenerate` settles nothing when no provider ran, because spec.md prices it "when the rerun invokes
   * providers" and a rerun that reused everything cost nothing to serve. It settles rather than releases, so
   * reconciliation can still see that the run happened — a released reservation means the user got nothing,
   * and here they got a fresh answer for free.
   */
  const chargeableUnits = input.operation === 'regenerate' && !outcome.providerInvoked ? 0 : card.units

  const settled = await settleReservation(transaction, principal, {
    reservationId: input.reservationId,
    actualUnits: chargeableUnits,
    idempotencyKey: `${input.idempotencyKey}:settle`,
  })

  log.info('solutions_credits_settled', {
    operation: card.operationKey,
    reservationId: input.reservationId,
    settledUnits: settled.reservation.settledUnits ?? chargeableUnits,
    providerInvoked: outcome.providerInvoked,
  })

  return {
    result: outcome.result,
    settledUnits: settled.reservation.settledUnits ?? chargeableUnits,
    providerReference: outcome.providerReference,
    released: false,
  }
}

/** Swallows its own failure on purpose — see the header's note on which error a caller needs to see. */
async function release(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: { reservationId: string; idempotencyKey: string },
  reason: string,
): Promise<void> {
  await releaseReservation(transaction, principal, {
    reservationId: input.reservationId,
    reason,
    idempotencyKey: `${input.idempotencyKey}:release`,
  }).catch(() => undefined)
}

/**
 * What a client needs to render a confirmation prompt, and nothing more.
 *
 * The charge and the version, so the confirmation it sends back can be matched against the card that produced
 * it. Deliberately not a balance: the balance is billing-owned, changes between render and confirm, and a client
 * that decided affordability for itself would be making a decision the platform has to make anyway at
 * reservation time.
 */
export function describeSolutionsCharge(operation: SolutionsRateCardOperation): {
  operationKey: string
  units: number
  rateCardVersion: number
} {
  const card = getSolutionsRateCardKey(operation)
  return { operationKey: card.operationKey, units: card.units, rateCardVersion: card.version }
}
