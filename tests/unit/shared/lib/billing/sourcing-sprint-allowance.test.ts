import { describe, expect, it } from 'vitest'
import {
  PLAN_PRICING,
  SOURCING_SPRINT_LIMITS,
  sourcingSprintAllowanceLabel,
  sourcingSprintFeature,
  type OrganizationTier,
} from '~/shared/lib/billing-shared'
import { TIER_PRESENTATION, type CatalogTier } from '~/shared/lib/billing/catalog'
import { resolveLegacyPlanTier } from '~/shared/lib/repositories/entitlements'

/**
 * The concurrent-sprint allowance is stated in four places and enforced in one.
 * Before this file it had drifted in two of them: `/pricing` advertised Pro Max
 * "up to 3" while `/api/sprints` allowed 10, and Pro was silently enforced at 3
 * while both the plan card and the comparison table advertised nothing.
 *
 * `SOURCING_SPRINT_LIMITS` is the enforced truth; everything customer-facing is
 * derived from it. These tests pin that relationship so re-typing a number by
 * hand fails here instead of on an invoice.
 */

const TIERS: OrganizationTier[] = ['free', 'pro', 'pro_max', 'team']

/** Reads the number back out of the advertised prose, the way a customer does. */
function advertisedIn(features: string[]): number | null {
  const bullet = features.find((feature) => /sourcing sprints/i.test(feature))
  if (!bullet) return null
  const match = bullet.match(/(\d+)/)
  expect(match, `sprint bullet "${bullet}" states no number`).not.toBeNull()
  return Number(match![1])
}

describe('the enforced allowance', () => {
  it('has an explicit row for every tier an entitlement can carry, Pro Max included', () => {
    expect(Object.keys(SOURCING_SPRINT_LIMITS).sort()).toEqual(['free', 'pro', 'pro_max', 'team'])
  })

  it('gives Free none, Pro three, Pro Max ten, Team ten', () => {
    expect(SOURCING_SPRINT_LIMITS).toEqual({ free: 0, pro: 3, pro_max: 10, team: 10 })
  })

  it('never decreases as the tier gets more expensive', () => {
    // Catches an inversion where a cheaper tier ends up out-earning a dearer one.
    const ladder = TIERS.map((tier) => SOURCING_SPRINT_LIMITS[tier])
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder)
  })

  it('does not need resolveLegacyPlanTier — Pro Max reads its own row, not Team\'s', () => {
    // The routes index by `entitlement.tier` directly now. If someone reinstates
    // the legacy mapping here, this still passes only while the two numbers
    // coincide, so assert the row exists independently of its value.
    expect(SOURCING_SPRINT_LIMITS).toHaveProperty('pro_max')
    expect(SOURCING_SPRINT_LIMITS.pro_max).toBe(SOURCING_SPRINT_LIMITS[resolveLegacyPlanTier('pro_max')])
  })
})

describe('advertised allowance matches the enforced one, for every tier', () => {
  it.each(TIERS)('%s: the Stripe plan card states exactly what the routes allow', (tier) => {
    const advertised = advertisedIn(TIER_PRESENTATION[tier as CatalogTier].features)
    const enforced = SOURCING_SPRINT_LIMITS[tier]
    if (enforced === 0) {
      // A tier with no allowance advertises nothing rather than "up to 0".
      expect(advertised).toBeNull()
    } else {
      expect(advertised).toBe(enforced)
    }
  })

  it.each(['free', 'pro', 'team'] as const)(
    '%s: the legacy manual plan card (served by /api/plans/me) states the same number',
    (tier) => {
      const advertised = advertisedIn(PLAN_PRICING[tier].features)
      const enforced = SOURCING_SPRINT_LIMITS[tier]
      if (enforced === 0) expect(advertised).toBeNull()
      else expect(advertised).toBe(enforced)
    },
  )

  it('the comparison-table cell states the same number, or nothing at all', () => {
    for (const tier of TIERS) {
      const label = sourcingSprintAllowanceLabel(tier)
      const enforced = SOURCING_SPRINT_LIMITS[tier]
      if (enforced === 0) expect(label).toBeNull()
      else expect(label).toBe(`Up to ${enforced}`)
    }
  })
})

describe('the formatters', () => {
  it('omit a bullet entirely for a zero allowance', () => {
    expect(sourcingSprintFeature('free')).toBeNull()
    expect(sourcingSprintAllowanceLabel('free')).toBeNull()
  })

  it('read from the map rather than from a literal', () => {
    expect(sourcingSprintFeature('pro')).toBe(`AI sourcing sprints (up to ${SOURCING_SPRINT_LIMITS.pro})`)
    expect(sourcingSprintAllowanceLabel('team')).toBe(`Up to ${SOURCING_SPRINT_LIMITS.team}`)
  })

  it('produce exactly one sprint bullet per paid plan card — never a stale duplicate', () => {
    for (const tier of ['pro', 'pro_max', 'team'] as const) {
      const bullets = TIER_PRESENTATION[tier].features.filter((f) => /sourcing sprints/i.test(f))
      expect(bullets).toHaveLength(1)
    }
  })
})
