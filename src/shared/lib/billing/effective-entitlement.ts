import type { TenantTransaction } from '../db/client'
import { getOrganizationEntitlement, type EntitlementPolicy, type EntitlementTier } from '../repositories/entitlements'
import { tierMeetsMinimum } from './rate-cards'
import { getBetaModeState, type BetaModeState } from './beta-mode'

/**
 * The one boundary between the entitlement an organization **has** and the one it may **use** during a
 * public beta (plan 58).
 *
 * ## Why this is a separate function and not a change to `getOrganizationEntitlement`
 *
 * `getOrganizationEntitlement` is the raw billing and provenance read. Checkout, the Stripe projection,
 * webhooks, dunning, refunds, operator grants and admin reporting all need to know what the
 * organization actually bought — a beta overlay leaking into any of those turns a promotional flag into
 * a false financial record. So the raw read keeps its meaning and this adds a second, explicitly named
 * one.
 *
 * The superseded draft applied the override inside one enforcement path and left the others alone,
 * which produces the worst possible state: the UI and the non-metered limits say Pro Max while
 * provider-backed work still refuses with `no_subscription`.
 *
 * ## What it raises, and what it must not
 *
 * Only `tier` and `paidActionsAllowed`. Everything else — `status`, `active`, `seatLimit`,
 * `paymentBlocked` — is preserved exactly:
 *
 * - **Seats are not raised.** Beta mode is about product capability, not headcount. Raising the seat
 *   limit would let organizations add members they lose access to the moment beta ends.
 * - **`paymentBlocked` still wins.** `paidActionsAllowed` becomes true for beta access *only* when
 *   payment is not blocked, so an organization in dunning does not get free provider work by way of a
 *   promotional flag.
 * - **Team is not downgraded.** The comparison uses `tierMeetsMinimum`, the existing rank, where Team
 *   and Pro Max are equivalent for features. A second, contradictory tier ordering was one of the
 *   defects in the earlier draft.
 */
export interface EffectiveEntitlementPolicy extends EntitlementPolicy {
  /** What the organization actually holds. Never overwritten, so a caller can always tell the two apart. */
  actualTier: EntitlementTier
  betaModeActive: boolean
}

const BETA_TIER: EntitlementTier = 'pro_max'

/**
 * The pure resolver. No I/O, so the whole policy is testable as a table.
 */
export function applyBetaModeEntitlement(
  actual: EntitlementPolicy,
  beta: Pick<BetaModeState, 'enabled'>,
): EffectiveEntitlementPolicy {
  const base: EffectiveEntitlementPolicy = {
    ...actual,
    actualTier: actual.tier,
    betaModeActive: false,
  }
  if (!beta.enabled) return base

  // `tierMeetsMinimum(actual, BETA_TIER)` is true for Team as well as Pro Max, so neither is touched.
  // Beta mode is a floor, and a floor never lowers anything.
  const alreadyAtLeastBeta = tierMeetsMinimum(actual.tier, BETA_TIER)

  return {
    ...base,
    betaModeActive: true,
    tier: alreadyAtLeastBeta ? actual.tier : BETA_TIER,
    // The one place beta access can unblock paid actions — and only when nothing else is blocking them.
    paidActionsAllowed: actual.paymentBlocked ? false : true,
  }
}

/**
 * The read product enforcement should use.
 *
 * Reads the flag in the caller's transaction, so a disable that has committed is visible to the very
 * next authorization rather than a cache TTL later.
 */
export async function getEffectiveOrganizationEntitlement(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<EffectiveEntitlementPolicy> {
  const [actual, beta] = await Promise.all([
    getOrganizationEntitlement(transaction, organizationId),
    getBetaModeState(transaction),
  ])
  return applyBetaModeEntitlement(actual, beta)
}
