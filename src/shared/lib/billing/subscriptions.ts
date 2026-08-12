/**
 * Projects `billing_subscriptions`' authoritative Stripe state into
 * `organization_entitlements` (plans/implemented/30-stripe-billing-platform/tasks.md §7
 * "Project paid subscription and monthly renewal state"). This is a
 * read-model projection only: the monthly credit grant itself is already
 * handled by `webhook-handlers.ts`'s `handleInvoicePaid` (idempotent by
 * `invoice-grant:<invoiceId>`) — this module's job is exclusively the
 * tier/status/period/seat-limit projection, called from the SAME
 * transaction as the `billing_subscriptions` write in `handleSubscriptionUpsert`
 * so both commit atomically (never a subscription row with a stale
 * entitlement, or vice versa).
 *
 * "Preserve manual authority until voluntary cutover" (the task's own
 * wording): an organization that never has a real Stripe subscription is
 * never touched by this module — `projectSubscriptionEntitlement` is only
 * ever invoked from `handleSubscriptionUpsert`, which only runs for an
 * organization that actually owns a Stripe subscription event. Completing
 * real Stripe Checkout for that one organization IS the voluntary cutover;
 * every other org's manually-granted entitlement
 * (`sync_personal_organization_entitlement`, `setPlatformUserPlan`) is
 * completely unaffected.
 */
import { organizationEntitlements } from '../db/schema'
import type { WorkerTransaction } from '../db/worker-db'
import type { PlanStatus } from '../billing-shared'
import type { EntitlementTier } from '../repositories/entitlements'

export interface SubscriptionSnapshot {
  tier: Extract<EntitlementTier, 'pro' | 'pro_max' | 'team'>
  stripeStatus: string
  interval: 'monthly' | 'annual'
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  seatLimit: number
}

export interface EntitlementProjection {
  tier: EntitlementTier
  status: PlanStatus
  billingPeriod: 'monthly' | 'annual'
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  seatLimit: number
}

/**
 * Maps a Stripe subscription status to `organization_entitlements.status`.
 * Returns `null` for `incomplete`/`incomplete_expired` — the subscription's
 * initial payment never succeeded, so there is authoritative paid state yet
 * to project; the organization keeps whatever entitlement it already had
 * (free, or a pre-existing manually-granted plan) rather than being
 * promoted on a subscription that was never actually paid.
 */
export function mapStripeStatusToEntitlementStatus(stripeStatus: string): PlanStatus | null {
  switch (stripeStatus) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'past_due'
    // Stripe is still retrying payment (`unpaid`) or the subscription is
    // administratively paused (`paused`) — neither is good standing, and
    // both map to the same "paid features suspended" behavior as past_due
    // (`resolveEntitlementPolicy`'s `active` check only allows
    // active/trialing), without inventing a fifth entitlement status.
    case 'unpaid':
    case 'paused':
      return 'past_due'
    case 'canceled':
      return 'canceled'
    case 'incomplete':
    case 'incomplete_expired':
      return null
    default:
      return null
  }
}

/** Pure projection — no I/O. Returns `null` when there is nothing to project yet (see `mapStripeStatusToEntitlementStatus`). */
export function resolveEntitlementProjection(subscription: SubscriptionSnapshot): EntitlementProjection | null {
  const status = mapStripeStatusToEntitlementStatus(subscription.stripeStatus)
  if (!status) return null

  return {
    tier: subscription.tier,
    status,
    billingPeriod: subscription.interval,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    seatLimit: subscription.seatLimit,
  }
}

/**
 * Upserts `organization_entitlements` from the subscription's current
 * authoritative state. Call from inside the same transaction as the
 * `billing_subscriptions` write so both commit atomically. A no-op when
 * `resolveEntitlementProjection` returns `null` (nothing paid to project yet).
 */
export async function projectSubscriptionEntitlement(
  tx: WorkerTransaction,
  organizationId: string,
  subscription: SubscriptionSnapshot,
): Promise<void> {
  const projection = resolveEntitlementProjection(subscription)
  if (!projection) return

  await tx
    .insert(organizationEntitlements)
    .values({
      organizationId,
      tier: projection.tier,
      status: projection.status,
      billingPeriod: projection.billingPeriod,
      currentPeriodStart: projection.currentPeriodStart,
      currentPeriodEnd: projection.currentPeriodEnd,
      seatLimit: projection.seatLimit,
    })
    .onConflictDoUpdate({
      target: organizationEntitlements.organizationId,
      set: {
        tier: projection.tier,
        status: projection.status,
        billingPeriod: projection.billingPeriod,
        currentPeriodStart: projection.currentPeriodStart,
        currentPeriodEnd: projection.currentPeriodEnd,
        seatLimit: projection.seatLimit,
        updatedAt: new Date(),
      },
    })
}
