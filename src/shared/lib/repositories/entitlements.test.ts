import { describe, expect, it } from 'vitest'
import { resolveEntitlementPolicy } from './entitlements'

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
})
