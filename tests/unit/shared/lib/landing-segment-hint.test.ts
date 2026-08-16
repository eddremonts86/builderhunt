import { describe, expect, it } from 'vitest'
import {
  consumeSegmentHint,
  onboardingLinkFor,
  parseSegmentHint,
  SEGMENT_HINT_PARAM,
  SEGMENT_HINT_STORAGE_KEY,
  SEGMENT_HINT_TTL_MS,
  stashSegmentHint,
  type SegmentHintStorage,
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

/**
 * The stash carries the hint across the sign-up form (plan: phase-2/06-landing-segmentada).
 *
 * `sessionStorage` is writable by anything running on the origin, so everything that comes back out
 * of it is treated as no more trustworthy than what came out of the URL — which is what most of
 * these tests are about.
 */
function fakeStorage(initial: Record<string, string> = {}): SegmentHintStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
    removeItem: (key) => {
      delete data[key]
    },
  }
}

const NOW = 1_700_000_000_000

describe('stashing a hint across sign-up', () => {
  it('round-trips every real segment', () => {
    for (const segment of USER_SEGMENTS) {
      const storage = fakeStorage()
      expect(stashSegmentHint(segment, { storage, now: NOW })).toBe(segment)
      expect(consumeSegmentHint({ storage, now: NOW })).toBe(segment)
    }
  })

  /** A writer that trusted its caller would be one careless call away from storing anything at all. */
  it('stores nothing for a value that is not a segment', () => {
    const storage = fakeStorage()
    for (const bad of ['recruiter', 'general', '', null, undefined, 42, { segment: 'hiring' }]) {
      expect(stashSegmentHint(bad, { storage, now: NOW })).toBeNull()
    }
    expect(storage.data[SEGMENT_HINT_STORAGE_KEY]).toBeUndefined()
    expect(consumeSegmentHint({ storage, now: NOW })).toBeNull()
  })

  /** One screen, once. A hint that survived its own reading would keep deciding later ones. */
  it('is spent by the first read', () => {
    const storage = fakeStorage()
    stashSegmentHint('investing', { storage, now: NOW })

    expect(consumeSegmentHint({ storage, now: NOW })).toBe('investing')
    expect(consumeSegmentHint({ storage, now: NOW })).toBeNull()
    expect(storage.data[SEGMENT_HINT_STORAGE_KEY]).toBeUndefined()
  })

  it('is cleared even when what it holds is unusable', () => {
    const storage = fakeStorage({ [SEGMENT_HINT_STORAGE_KEY]: 'not json at all' })
    expect(consumeSegmentHint({ storage, now: NOW })).toBeNull()
    expect(storage.data[SEGMENT_HINT_STORAGE_KEY]).toBeUndefined()
  })

  it('expires, rather than deciding an onboarding started tomorrow', () => {
    const storage = fakeStorage()
    stashSegmentHint('building', { storage, now: NOW })

    expect(consumeSegmentHint({ storage: fakeStorage(storage.data), now: NOW + SEGMENT_HINT_TTL_MS - 1 })).toBe('building')
    // Exactly at the boundary counts as expired: a hint is worth nothing at the moment it runs out.
    expect(consumeSegmentHint({ storage: fakeStorage(storage.data), now: NOW + SEGMENT_HINT_TTL_MS })).toBeNull()
    expect(consumeSegmentHint({ storage, now: NOW + SEGMENT_HINT_TTL_MS * 2 })).toBeNull()
  })

  /**
   * Anything on the origin can write this key by hand. Each of these is a shape somebody could
   * leave there, and every one has to read as "no hint" rather than as the value it claims.
   */
  it('refuses a hand-written entry, whatever shape it is in', () => {
    const forged = [
      JSON.stringify({ segment: 'hiring' }), // no expiry — the obvious way to make one permanent
      JSON.stringify({ segment: 'hiring', expiresAt: 'never' }),
      JSON.stringify({ segment: 'hiring', expiresAt: Number.POSITIVE_INFINITY }),
      JSON.stringify({ segment: 'platform_admin', expiresAt: NOW + 1000 }),
      JSON.stringify({ segment: 'general', expiresAt: NOW + 1000 }),
      JSON.stringify(['hiring', NOW + 1000]),
      JSON.stringify('hiring'),
      JSON.stringify(null),
      '',
    ]
    for (const raw of forged) {
      const storage = fakeStorage({ [SEGMENT_HINT_STORAGE_KEY]: raw })
      expect(consumeSegmentHint({ storage, now: NOW }), raw).toBeNull()
    }
  })

  /**
   * A browser with site data blocked throws on the storage call itself. Not being able to preselect
   * a radio button must never surface as an error, let alone interrupt a sign-up.
   */
  it('survives storage that is absent or throws', () => {
    const throwing: SegmentHintStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }

    expect(() => stashSegmentHint('hiring', { storage: throwing })).not.toThrow()
    expect(stashSegmentHint('hiring', { storage: throwing })).toBeNull()
    expect(() => consumeSegmentHint({ storage: throwing })).not.toThrow()
    expect(consumeSegmentHint({ storage: throwing })).toBeNull()

    expect(stashSegmentHint('hiring', { storage: null })).toBeNull()
    expect(consumeSegmentHint({ storage: null })).toBeNull()
  })

  /** Storing a second hint replaces the first: the most recent link is the one that describes them. */
  it('keeps only the latest hint', () => {
    const storage = fakeStorage()
    stashSegmentHint('hiring', { storage, now: NOW })
    stashSegmentHint('building', { storage, now: NOW })

    expect(consumeSegmentHint({ storage, now: NOW })).toBe('building')
  })
})
