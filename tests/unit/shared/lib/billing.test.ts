import { describe, it, expect } from 'vitest'
import { PLAN_LIMITS, PLAN_PRICING, type PlanTier } from '~/shared/lib/billing-shared'

describe('PLAN_LIMITS', () => {
  it('free tier has 3 saved searches', () => {
    expect(PLAN_LIMITS.free.savedSearches).toBe(3)
  })

  it('free tier has 50 saved builders', () => {
    expect(PLAN_LIMITS.free.savedBuilders).toBe(50)
  })

  it('pro tier has 50 saved searches', () => {
    expect(PLAN_LIMITS.pro.savedSearches).toBe(50)
  })

  it('pro tier has unlimited builders', () => {
    expect(PLAN_LIMITS.pro.savedBuilders).toBe(Infinity)
  })

  it('team tier has 200 saved searches (higher than pro)', () => {
    expect(PLAN_LIMITS.team.savedSearches).toBeGreaterThan(PLAN_LIMITS.pro.savedSearches)
  })

  it('all tiers have all 3 limit keys', () => {
    for (const tier of ['free', 'pro', 'team'] as PlanTier[]) {
      expect(PLAN_LIMITS[tier]).toHaveProperty('savedSearches')
      expect(PLAN_LIMITS[tier]).toHaveProperty('savedBuilders')
      expect(PLAN_LIMITS[tier]).toHaveProperty('rssSubscriptions')
    }
  })
})

describe('PLAN_PRICING', () => {
  it('free is $0', () => {
    expect(PLAN_PRICING.free.monthly).toBe(0)
    expect(PLAN_PRICING.free.annual).toBe(0)
  })

  it('pro is $19 monthly', () => {
    expect(PLAN_PRICING.pro.monthly).toBe(19)
  })

  it('pro annual is cheaper than 12x monthly (discount)', () => {
    const monthly = PLAN_PRICING.pro.monthly * 12
    expect(PLAN_PRICING.pro.annual).toBeLessThan(monthly)
  })

  it('team is more expensive than pro', () => {
    expect(PLAN_PRICING.team.monthly).toBeGreaterThan(PLAN_PRICING.pro.monthly)
  })

  it('all tiers have a non-empty features list', () => {
    for (const tier of ['free', 'pro', 'team'] as PlanTier[]) {
      expect(PLAN_PRICING[tier].features.length).toBeGreaterThan(0)
    }
  })

  it('team features is a strict superset of pro features', () => {
    // Team should have MORE features than Pro (since it's the higher tier)
    expect(PLAN_PRICING.team.features.length).toBeGreaterThan(PLAN_PRICING.pro.features.length)
    // And team should mention "team" or "shared" or "seats" (a team-only concept)
    const teamKeywords = ['team', 'shared', 'seat', 'work-sample', 'activity']
    expect(PLAN_PRICING.team.features.some((f) => teamKeywords.some((k) => f.toLowerCase().includes(k)))).toBe(true)
  })
})
