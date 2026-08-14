import { describe, expect, it } from 'vitest'
import {
  onboardingLinkFor,
  parseSegmentHint,
  SEGMENT_HINT_PARAM,
} from '~/shared/lib/landing-segment-hint'
import { USER_SEGMENTS } from '~/shared/lib/user-segments'

/**
 * The hint is attacker-controlled input. Anybody can send anybody a link, so everything here is
 * about the hint being able to *preselect* and never to *persist*.
 */

describe('parsing a hint', () => {
  it('accepts each real segment, from a query string, a URL or params', () => {
    for (const segment of USER_SEGMENTS) {
      expect(parseSegmentHint(`?${SEGMENT_HINT_PARAM}=${segment}`)).toBe(segment)
      expect(parseSegmentHint(`https://builderhunt.dev/onboarding/goal?${SEGMENT_HINT_PARAM}=${segment}`)).toBe(segment)
      expect(parseSegmentHint(new URLSearchParams({ [SEGMENT_HINT_PARAM]: segment }))).toBe(segment)
    }
  })

  /**
   * A manipulated hint must be indistinguishable from no hint. If a bad value produced a different
   * outcome from an absent one, the URL would become a way to probe which values the enum accepts.
   */
  it('returns null for anything else, exactly as it does for nothing', () => {
    const absent = parseSegmentHint(null)
    for (const bad of ['?goal=recruiter', '?goal=general', '?goal=', '?other=hiring', '', '???', 'not a url']) {
      expect(parseSegmentHint(bad)).toBe(absent)
    }
    expect(absent).toBeNull()
  })

  it('never throws, whatever it is handed', () => {
    for (const input of [undefined, null, '', '%%%', 'http://', '?a=b&a=c']) {
      expect(() => parseSegmentHint(input)).not.toThrow()
    }
  })

  it('ignores a second, unrelated parameter', () => {
    expect(parseSegmentHint('?utm_source=x&goal=building&ref=y')).toBe('building')
  })
})

describe('building a link', () => {
  it('round-trips through the parser', () => {
    for (const segment of USER_SEGMENTS) {
      expect(parseSegmentHint(onboardingLinkFor(segment))).toBe(segment)
    }
  })

  it('points at the goal step by default and encodes the value', () => {
    expect(onboardingLinkFor('hiring')).toBe('/onboarding/goal?goal=hiring')
  })
})
