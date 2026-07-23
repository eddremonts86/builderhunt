import { eq } from 'drizzle-orm'
import type { PlanStatus, PlanTier } from '../billing-shared'
import type { TenantTransaction } from '../db/client'
import { organizationEntitlements } from '../db/schema'

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

export function resolveEntitlementPolicy(entitlement: EntitlementInput | null): EntitlementPolicy {
  if (!entitlement) {
    return {
      tier: 'free',
      status: 'active',
      active: true,
      paidActionsAllowed: false,
      seatLimit: 1,
    }
  }

  const tier = asTier(entitlement.tier)
  const status = asStatus(entitlement.status)
  const active = status === 'active' || status === 'trialing'
  return {
    tier,
    status,
    active,
    paidActionsAllowed: active && tier !== 'free',
    seatLimit: entitlement.seatLimit,
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

  return resolveEntitlementPolicy(row ?? null)
}

function asTier(value: string): EntitlementTier {
  if (value === 'free' || value === 'pro' || value === 'pro_max' || value === 'team') return value
  throw new Error('Invalid organization entitlement tier')
}

function asStatus(value: string): PlanStatus {
  if (value === 'active' || value === 'past_due' || value === 'canceled' || value === 'trialing') return value
  throw new Error('Invalid organization entitlement status')
}
