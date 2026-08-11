import { and, eq, isNull } from 'drizzle-orm'
import type { OrganizationTier, PlanStatus, PlanTier } from '../billing-shared'
import type { TenantTransaction } from '../db/client'
import { billingSubscriptions, organizationEntitlements } from '../db/schema'

interface EntitlementInput {
  tier: string
  status: string
  seatLimit: number
}

/**
 * `PlanTier` plus Pro Max — the Stripe-native tier `subscriptions.ts` can
 * project into `organization_entitlements` (plans/implemented/30-stripe-billing-platform/tasks.md
 * §7 "Project paid subscription and monthly renewal state").
 *
 * Declared in the client-safe `billing-shared.ts` as `OrganizationTier` and
 * re-exported here under the name every server call site already uses. It lives
 * there so a per-tier allowance can be keyed by it and read by both the pricing
 * page and the route that enforces it; see that declaration for why it is not a
 * widening of `PlanTier`.
 */
export type EntitlementTier = OrganizationTier

export interface EntitlementPolicy {
  tier: EntitlementTier
  status: PlanStatus
  active: boolean
  paidActionsAllowed: boolean
  seatLimit: number
  /** True once the seven-day payment-grace period has run out (`dunning.ts` / `billing_subscriptions.paymentBlockedAt`) — an org-wide gate independent of `status`, since Stripe's own subscription status often stays `active` throughout automatic retries (spec.md: "Configure Stripe retries inside that window"). Never affects reads — only `paidActionsAllowed`. */
  paymentBlocked: boolean
}

/**
 * The remaining `Record<PlanTier, ...>` tables — `PLAN_LIMITS` (saved searches,
 * saved builders, RSS), the AI task allowances in `ai/tasks.ts`, and the
 * manual-billing UI card — predate Pro Max and have no dedicated entry for it,
 * a product decision rather than a technical one. Until they get one, a Pro Max
 * organization reads Team's row: Team sits at the top of each of those tables,
 * so this never under-serves a paying Pro Max customer.
 *
 * Do NOT reach for this when the allowance is also *advertised* somewhere. An
 * allowance the pricing page states must be keyed by `OrganizationTier` and
 * indexed by `entitlement.tier` directly, so copy and enforcement read the same
 * row — `SOURCING_SPRINT_LIMITS` used to come through here and drifted by 7
 * sprints (advertised 3 for Pro Max, enforced 10) before anyone noticed.
 */
export function resolveLegacyPlanTier(tier: EntitlementTier): PlanTier {
  return tier === 'pro_max' ? 'team' : tier
}

export function resolveEntitlementPolicy(entitlement: EntitlementInput | null, paymentBlocked = false): EntitlementPolicy {
  if (!entitlement) {
    return {
      tier: 'free',
      status: 'active',
      active: true,
      paidActionsAllowed: false,
      seatLimit: 1,
      paymentBlocked,
    }
  }

  const tier = asTier(entitlement.tier)
  const status = asStatus(entitlement.status)
  const active = status === 'active' || status === 'trialing'
  return {
    tier,
    status,
    active,
    paidActionsAllowed: active && tier !== 'free' && !paymentBlocked,
    seatLimit: entitlement.seatLimit,
    paymentBlocked,
  }
}

export async function getOrganizationEntitlement(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<EntitlementPolicy> {
  const [row] = await transaction
    .select({
      tier: organizationEntitlements.tier,
      status: organizationEntitlements.status,
      seatLimit: organizationEntitlements.seatLimit,
    })
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1)

  const [subscriptionRow] = await transaction
    .select({ paymentBlockedAt: billingSubscriptions.paymentBlockedAt })
    .from(billingSubscriptions)
    .where(and(eq(billingSubscriptions.organizationId, organizationId), isNull(billingSubscriptions.canceledAt)))
    .limit(1)

  return resolveEntitlementPolicy(row ?? null, Boolean(subscriptionRow?.paymentBlockedAt))
}

export interface EntitlementPeriod {
  billingPeriod: string
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
  notes: string | null
}

/**
 * The manual/legacy period fields on `organization_entitlements` itself — kept in sync with a real
 * Stripe subscription by `subscriptions.ts`'s `projectSubscriptionEntitlement` (§7 task 1), so this
 * is correct for BOTH a Stripe-driven org and a manually-granted one (which has no `billing_subscriptions`
 * row at all). Separate from `getOrganizationEntitlement`'s own `EntitlementPolicy` since period/notes
 * are display detail, not an authorization decision.
 */
export async function getOrganizationEntitlementPeriod(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<EntitlementPeriod> {
  const [row] = await transaction
    .select({
      billingPeriod: organizationEntitlements.billingPeriod,
      currentPeriodEnd: organizationEntitlements.currentPeriodEnd,
      trialEndsAt: organizationEntitlements.trialEndsAt,
      notes: organizationEntitlements.notes,
    })
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1)

  return row ?? { billingPeriod: 'none', currentPeriodEnd: null, trialEndsAt: null, notes: null }
}

function asTier(value: string): EntitlementTier {
  if (value === 'free' || value === 'pro' || value === 'pro_max' || value === 'team') return value
  throw new Error('Invalid organization entitlement tier')
}

function asStatus(value: string): PlanStatus {
  if (value === 'active' || value === 'past_due' || value === 'canceled' || value === 'trialing') return value
  throw new Error('Invalid organization entitlement status')
}
