/**
 * The billing-owned balance and action DTOs a Solutions surface renders from (plan 43 Phase 6, "Add entitlement
 * and reservation orchestration": "expose billing-owned balance/action DTOs").
 *
 * **Server-only**, like its sibling `billing.ts`.
 *
 * ## Why the server decides, and hands over a decision rather than the inputs
 *
 * The DTO carries `canGenerate` and a reason, not just a balance and a price. A client given the two numbers
 * would have to implement "can I afford this" itself, and the moment that implementation drifts from
 * `reserveCredits` the UI offers an action the reservation then refuses — the worst version of this bug being
 * the one where the button is enabled, the user confirms a charge, and the refusal arrives after they committed.
 *
 * `balanceUnits` comes from `getAvailableCreditBalance`, the same function the reservation layer consults, for
 * the same reason: two implementations of "what can I spend" cannot be kept in step.
 *
 * This is not in tension with `describeSolutionsCharge`, which deliberately carries no balance. That one is the
 * confirmation echo — the price and version a user agreed to, matched on the way back in. This one is the
 * page's initial state. A confirmation that carried a balance would invite a client to re-decide affordability
 * at submit time, which is the platform's job at reservation time.
 */
import { getAvailableCreditBalance } from '~/shared/lib/billing/credits'
import { checkEntitlement } from '~/shared/lib/billing/feature-authorization'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { getSolutionsFeatureFlags, getSolutionsRateCardKey, type SolutionsRateCardOperation } from '~/shared/lib/solutions/config'

/** The exact charge for one operation, as it must be displayed before confirmation. */
export interface SolutionsChargeDto {
  operation: SolutionsRateCardOperation
  /** The whole price in credits — not a ceiling. See `~/shared/lib/billing/rate-cards.ts`. */
  units: number
  /** Echoed back with the confirmation, so a stale client is refused rather than billed at a changed price. */
  rateCardVersion: number
}

/**
 * Why an operation is unavailable.
 *
 * Distinct causes rather than one boolean, because they need different words and lead to different places: a
 * disabled feature is nobody's fault and has no remedy the user can buy, `tier_too_low` sends them to upgrade,
 * and `insufficient_credits` sends them to a credit pack. Collapsing them would send everyone to the pricing
 * page, including the people an upgrade cannot help.
 */
export type SolutionsUnavailableReason =
  | 'feature_disabled'
  | 'no_subscription'
  | 'tier_too_low'
  | 'insufficient_credits'
  | 'unknown_feature'

export interface SolutionsActionDto {
  charge: SolutionsChargeDto
  available: boolean
  unavailableReason: SolutionsUnavailableReason | null
}

export interface SolutionsBillingStateDto {
  /** The organization's spendable balance, from billing. Reserved units are already excluded. */
  balanceUnits: number
  generate: SolutionsActionDto
  regenerate: SolutionsActionDto
}

/**
 * Builds the state for both Solutions operations.
 *
 * Read-only: it never reserves, and `reserveCredits` re-checks everything regardless — a client's earlier
 * entitlement check is never trusted. What this buys is a surface that does not offer what it cannot deliver.
 *
 * The balance is read once and compared against each price, rather than per operation, so the two actions cannot
 * disagree about the same balance within one response.
 */
export async function describeSolutionsBillingState(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
): Promise<SolutionsBillingStateDto> {
  const paidEnabled = getSolutionsFeatureFlags().paidGenerationEnabled
  const balanceUnits = await getAvailableCreditBalance(transaction, principal.organizationId)

  return {
    balanceUnits,
    generate: await describeAction(transaction, principal, 'generate', balanceUnits, paidEnabled),
    regenerate: await describeAction(transaction, principal, 'regenerate', balanceUnits, paidEnabled),
  }
}

async function describeAction(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  operation: SolutionsRateCardOperation,
  balanceUnits: number,
  paidEnabled: boolean,
): Promise<SolutionsActionDto> {
  const card = getSolutionsRateCardKey(operation)
  const charge: SolutionsChargeDto = { operation, units: card.units, rateCardVersion: card.version }

  // The flag first, in the same order `withSolutionsCredits` checks it. A user on the right tier with a full
  // balance must not be told they lack entitlement when the truth is the feature is off.
  if (!paidEnabled) return { charge, available: false, unavailableReason: 'feature_disabled' }

  const entitlement = await checkEntitlement(transaction, principal, { feature: card.operationKey })
  if (!entitlement.allowed) return { charge, available: false, unavailableReason: entitlement.reason }

  // `<` rather than `<=`: a balance exactly equal to the price affords exactly one run, and refusing it would
  // strand the last credits of every organization.
  if (balanceUnits < card.units) return { charge, available: false, unavailableReason: 'insufficient_credits' }

  return { charge, available: true, unavailableReason: null }
}
