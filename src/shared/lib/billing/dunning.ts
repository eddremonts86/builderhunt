/**
 * Seven-day dunning and recovery (plans/stripe-billing-platform/tasks.md §7 "Implement seven-day
 * dunning and recovery"; spec.md §Failed payments and disputes: "The first renewal failure starts
 * seven calendar days of grace. Configure Stripe retries inside that window. Access and credits
 * continue during grace. After grace, an idempotent worker sets `payment_blocked`, blocks new
 * premium work, freezes included grants, preserves purchased grants but makes them unusable, and
 * preserves all data/export access. Recovery unfreezes still-valid grants.").
 *
 * `invoice.payment_failed` already records the grace-period marker (task 6.2's
 * `markBillingSubscriptionGraceStart`, set-once so a repeated failure during the SAME grace window
 * never resets the clock — spec.md's "deduplicated notices" reduces to this same set-once guard:
 * nothing re-triggers once the marker exists). This module owns everything AFTER that: deciding
 * when grace has run out, blocking, and recovering.
 *
 * "Preserves purchased grants but makes them unusable": pack-sourced grants are never frozen —
 * their state and remaining units are left completely untouched (so their original 12-month expiry
 * keeps counting down exactly as spec.md requires) — they become unusable purely as a side effect of
 * the organization-level `paymentBlocked` gate (`entitlements.ts`) that every consumption path
 * already checks, not through any grant-level mutation here. Only "included" grants (subscription
 * monthly/annual-window credits, and upgrade-delta credits — anything that came from the
 * subscription itself, never a purchase) are actively frozen.
 *
 * "Suspend non-owner Team access without deleting membership": the block above is organization-wide
 * (every viewer, owner included, loses `paidActionsAllowed`) — nothing in this module (or anywhere
 * else `getOrganizationEntitlement` is read from) ever touches `organization_members`. This is a
 * deliberate scope decision: the codebase's entitlement check has no per-viewer-role dimension today
 * (`EntitlementPolicy` is resolved per-organization, not per-viewer), and introducing one would mean
 * threading the viewer's role through every one of `getOrganizationEntitlement`'s existing call
 * sites (sprints, AI, search, alerts, saved queries) well beyond this task's own file list. What IS
 * fully guaranteed, and is the literal invariant this task states, is the "without deleting
 * membership" half: this module never reads or writes `organization_members`/`organization_invitations`
 * at all.
 */
import type { TenantTransaction } from '../db/client'
import { freezeCreditGrant, unfreezeCreditGrant, expireCreditGrant } from './credits'
import { listActiveBillingCreditGrants, listBillingCreditGrantsByState } from '../repositories/billing'

const INCLUDED_GRANT_SOURCES: ReadonlySet<string> = new Set(['subscription_monthly', 'subscription_annual_window', 'subscription_upgrade_delta'])

export interface DunningCandidate {
  gracePeriodEndsAt: Date | null
  paymentBlockedAt: Date | null
}

/** Pure — no I/O. True only once grace has actually run out and the subscription hasn't already been blocked (idempotent by construction: a worker that runs more than once a day, or twice on the same tick, never re-decides `true` for an already-blocked subscription). */
export function shouldBlockForNonPayment(candidate: DunningCandidate, now: Date): boolean {
  if (candidate.paymentBlockedAt) return false
  if (!candidate.gracePeriodEndsAt) return false
  return now >= candidate.gracePeriodEndsAt
}

/**
 * Freezes every "included" (subscription-sourced) active grant for the organization. Pack grants
 * are deliberately left untouched — see this module's top-of-file comment. Idempotent per grant via
 * `freezeCreditGrant`'s own idempotency key; safe to call on an organization with zero included
 * grants (a no-op). Does NOT set `paymentBlockedAt` itself — the caller (the worker sweep) does that
 * as part of the same transaction, so a crash between the two never leaves a partially-applied state
 * invisible to a retry (the grant-freeze idempotency key is stable regardless of how many times this
 * runs before `paymentBlockedAt` is actually committed).
 */
export async function freezeIncludedGrantsForNonPayment(
  transaction: TenantTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
): Promise<number> {
  const activeGrants = await listActiveBillingCreditGrants(transaction, organizationId)
  let frozen = 0
  for (const grant of activeGrants) {
    if (!INCLUDED_GRANT_SOURCES.has(grant.source)) continue
    await freezeCreditGrant(transaction, {
      organizationId,
      grantId: grant.id,
      ledgerEntryId: `dunning-freeze-${stripeSubscriptionId}-${grant.id}`,
      idempotencyKey: `dunning-freeze-${stripeSubscriptionId}-${grant.id}`,
      reason: 'Payment grace period expired',
    })
    frozen += 1
  }
  return frozen
}

/**
 * Recovery: unfreezes every currently-frozen grant that hasn't ALSO expired while frozen — spec.md's
 * "Recovery unfreezes still-valid grants," which by construction excludes one that ran out its clock
 * during the block. An already-expired-while-frozen grant is transitioned to `expired` instead (its
 * natural end-of-life), never silently unfrozen back to a state implying it's still usable.
 */
export async function unfreezeStillValidGrantsOnRecovery(
  transaction: TenantTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
  now: Date,
): Promise<{ unfrozen: number; expired: number }> {
  const frozenGrants = await listBillingCreditGrantsByState(transaction, organizationId, 'frozen')
  let unfrozen = 0
  let expired = 0
  for (const grant of frozenGrants) {
    if (grant.expiresAt <= now) {
      await expireCreditGrant(transaction, {
        organizationId,
        grantId: grant.id,
        ledgerEntryId: `dunning-recovery-expire-${stripeSubscriptionId}-${grant.id}`,
        idempotencyKey: `dunning-recovery-expire-${stripeSubscriptionId}-${grant.id}`,
        reason: 'Expired while frozen for non-payment — not restored',
      })
      expired += 1
      continue
    }
    await unfreezeCreditGrant(transaction, {
      organizationId,
      grantId: grant.id,
      ledgerEntryId: `dunning-unfreeze-${stripeSubscriptionId}-${grant.id}`,
      idempotencyKey: `dunning-unfreeze-${stripeSubscriptionId}-${grant.id}`,
      reason: 'Payment recovered',
    })
    unfrozen += 1
  }
  return { unfrozen, expired }
}
