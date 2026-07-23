import { describe, expect, it } from 'vitest'
import { resolveEntitlementPolicy, resolveLegacyPlanTier } from './entitlements'

describe('organization entitlement policy', () => {
  it('defaults a missing entitlement to the free plan', () => {
    expect(resolveEntitlementPolicy(null)).toMatchObject({ tier: 'free', active: true, seatLimit: 1 })
  })

  it('keeps data readable but denies paid actions for inactive plans', () => {
    const policy = resolveEntitlementPolicy({ tier: 'team', status: 'past_due', seatLimit: 10 })
    expect(policy).toMatchObject({ tier: 'team', active: false, paidActionsAllowed: false, seatLimit: 10 })
  })

  it('uses the selected organization row rather than user identity', () => {
    const personal = resolveEntitlementPolicy({ tier: 'pro', status: 'active', seatLimit: 1 })
    const team = resolveEntitlementPolicy({ tier: 'team', status: 'active', seatLimit: 10 })
    expect(personal.tier).toBe('pro')
    expect(team.tier).toBe('team')
  })

  it('accepts the Stripe-native pro_max tier (only projectSubscriptionEntitlement writes it, never a manual grant)', () => {
    const policy = resolveEntitlementPolicy({ tier: 'pro_max', status: 'active', seatLimit: 1 })
    expect(policy).toMatchObject({ tier: 'pro_max', active: true, paidActionsAllowed: true, seatLimit: 1 })
  })

  it('rejects an invalid tier string', () => {
    expect(() => resolveEntitlementPolicy({ tier: 'bogus', status: 'active', seatLimit: 1 })).toThrow()
  })
})

describe('resolveLegacyPlanTier', () => {
  it('passes free/pro/team through unchanged', () => {
    expect(resolveLegacyPlanTier('free')).toBe('free')
    expect(resolveLegacyPlanTier('pro')).toBe('pro')
    expect(resolveLegacyPlanTier('team')).toBe('team')
  })

  it('maps pro_max to team — the most generous existing legacy tier, until a Pro-Max-specific entry is designed', () => {
    expect(resolveLegacyPlanTier('pro_max')).toBe('team')
  })
})
