import { describe, expect, it } from 'vitest'
import {
  isInOnboardingV2Cohort,
  onboardingCohortBucket,
  parseRolloutPercent,
} from '~/shared/lib/onboarding-rollout'

/**
 * The cohort ramp (plan: phase-2/03-onboarding-segmentado).
 *
 * A percentage rollout is only useful if it holds three properties, and each of them is a way the
 * ramp can go wrong rather than a nicety: the same person always gets the same answer, raising the
 * percentage never takes the flow away from somebody halfway through it, and an unreadable setting
 * means "off" rather than "everybody".
 */

const IDS = Array.from({ length: 500 }, (_, index) => `user-${index}`)

describe('the bucket', () => {
  it('is the same every time for the same person', () => {
    for (const id of IDS.slice(0, 20)) {
      expect(onboardingCohortBucket(id)).toBe(onboardingCohortBucket(id))
    }
  })

  it('lands in 0..99', () => {
    for (const id of IDS) {
      const bucket = onboardingCohortBucket(id)
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(100)
    }
  })

  /**
   * Not a statistical claim, a sanity one: a hash that put everybody in a handful of buckets would
   * make a 10 % ramp silently mean 0 % or 40 %, and the failure would only show up in production.
   */
  it('spreads people across the range rather than clustering', () => {
    const buckets = new Set(IDS.map(onboardingCohortBucket))
    expect(buckets.size).toBeGreaterThan(60)
  })
})

describe('the ramp', () => {
  it('is nobody at 0 and everybody at 100', () => {
    for (const id of IDS.slice(0, 50)) {
      expect(isInOnboardingV2Cohort(id, 0)).toBe(false)
      expect(isInOnboardingV2Cohort(id, 100)).toBe(true)
    }
  })

  /**
   * The property that makes a ramp safe. If raising the percentage could *remove* somebody, a ramp
   * from 10 % to 20 % would drop people mid-flow back onto v1 — half-finished on one flow, resumed
   * on another.
   */
  it('only ever adds people as the percentage rises', () => {
    for (let percent = 0; percent < 100; percent += 5) {
      const inNow = IDS.filter((id) => isInOnboardingV2Cohort(id, percent))
      const inNext = new Set(IDS.filter((id) => isInOnboardingV2Cohort(id, percent + 5)))
      for (const id of inNow) expect(inNext.has(id), `${id} at ${percent}%`).toBe(true)
    }
  })

  it('grows roughly in proportion to the percentage', () => {
    const share = IDS.filter((id) => isInOnboardingV2Cohort(id, 50)).length / IDS.length
    expect(share).toBeGreaterThan(0.35)
    expect(share).toBeLessThan(0.65)
  })

  /** No stable identity to bucket, so no cohort — guessing would move somebody the moment they signed in. */
  it('excludes an empty user id at any percentage', () => {
    expect(isInOnboardingV2Cohort('', 100)).toBe(false)
  })
})

describe('reading the setting', () => {
  it.each([
    ['0', 0],
    ['25', 25],
    ['100', 100],
    ['150', 100],
    ['-10', 0],
    ['12.9', 12],
  ])('parses %s as %i', (raw, expected) => {
    expect(parseRolloutPercent(raw)).toBe(expected)
  })

  /** An unreadable percentage must mean off. The other way round, a typo ships v2 to everybody. */
  it.each([undefined, null, '', 'half', 'true'])('treats %s as 0', (raw) => {
    expect(parseRolloutPercent(raw as string | null | undefined)).toBe(0)
    expect(isInOnboardingV2Cohort('user-1', parseRolloutPercent(raw as string | null | undefined))).toBe(false)
  })
})
