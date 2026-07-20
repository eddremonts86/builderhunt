import { eq } from 'drizzle-orm'
import type { PlanStatus, PlanTier } from '../billing-shared'
import type { TenantTransaction } from '../db/client'
import { organizationEntitlements } from '../db/schema'

interface EntitlementInput {
  tier: string
  status: string
  seatLimit: number
}

export interface EntitlementPolicy {
  tier: PlanTier
  status: PlanStatus
  active: boolean
  paidActionsAllowed: boolean
  seatLimit: number
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

function asTier(value: string): PlanTier {
  if (value === 'free' || value === 'pro' || value === 'team') return value
  throw new Error('Invalid organization entitlement tier')
}

function asStatus(value: string): PlanStatus {
  if (value === 'active' || value === 'past_due' || value === 'canceled' || value === 'trialing') return value
  throw new Error('Invalid organization entitlement status')
}
