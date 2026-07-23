import { and, eq, isNull } from 'drizzle-orm'
import type { PlanStatus, PlanTier } from '../billing-shared'
import type { TenantTransaction } from '../db/client'
import { billingSubscriptions, organizationEntitlements } from '../db/schema'

interface EntitlementInput {
  tier: string
  status: string
  seatLimit: number
}

/**
 * `PlanTier` plus Pro Max — the Stripe-native tier `subscriptions.ts` can now
 * project into `organization_entitlements` (plans/stripe-billing-platform/tasks.md
 * §7 "Project paid subscription and monthly renewal state"). Kept distinct
 * from `PlanTier` itself rather than widening that type globally: `PlanTier`
 * also drives the legacy manual per-user plan system (`billing-shared.ts`'s
 * `PLAN_LIMITS`/`PLAN_PRICING`/etc., admin-grantable via `setPlatformUserPlan`),
 * which cannot manually grant Pro Max — only a real Stripe subscription can.
 */
export type EntitlementTier = PlanTier | 'pro_max'

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
 * Every legacy `Record<PlanTier, ...>` table (saved-search/sprint limits, AI
 * call allowances, the manual-billing UI card) predates Pro Max and has no
 * dedicated entry for it yet — a product decision, not a technical one.
 * Until that entry exists, a Pro Max organization is treated as Team for
 * these legacy lookups: Team sits at the top of every one of those tables
 * today, so this never under-serves a paying Pro Max customer while a
 * Pro-Max-specific row is designed.
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
