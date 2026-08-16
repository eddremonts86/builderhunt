import { describe, expect, it } from 'vitest'
import {
  parseUserSegment,
  resolveSegmentPreset,
  SEGMENT_PRESETS,
  SEGMENT_SCHEMA_VERSION,
  SEGMENT_SCOPE_NOTICE,
  SEGMENT_SOURCES,
  segmentSourceSchema,
  USER_SEGMENT_COPY,
  USER_SEGMENTS,
  userSegmentSchema,
} from '~/shared/lib/user-segments'

/**
 * The contract every other part of phase-2 imports.
 *
 * Most of what is pinned here is pinned because breaking it would be *silent*: a fifth segment
 * added without a schema bump, `general` leaking into the picker, or `null` starting to throw
 * instead of meaning "not chosen yet".
 */

describe('the taxonomy', () => {
  it('is exactly the four documented values, in order', () => {
    expect(USER_SEGMENTS).toEqual(['hiring', 'investing', 'building', 'other'])
  })

  /**
   * `user` describes no job and no need — everyone is a user. It is called out in the phase README
   * as an explicit non-value, so this asserts the absence rather than trusting the list above.
   */
  it('does not contain `user`', () => {
    expect(USER_SEGMENTS as readonly string[]).not.toContain('user')
  })

  it('rejects anything outside it, including near-misses', () => {
    for (const bad of ['Hiring', 'recruiter', 'user', '', 'general', null, undefined, 1, {}]) {
      expect(userSegmentSchema.safeParse(bad).success).toBe(false)
    }
  })

  /**
   * The version is what makes the taxonomy revisable without rewriting history: a row stored under
   * version 1 keeps meaning what version 1 meant. Changing the segment list without bumping it is
   * the mistake this pins.
   */
  it('pins the schema version alongside the list it describes', () => {
    expect(SEGMENT_SCHEMA_VERSION).toBe(1)
    expect(USER_SEGMENTS).toHaveLength(4)
  })
})

describe('null, and the general preset', () => {
  /**
   * Every existing account starts `null` and is allowed to stay there. `resolveSegmentPreset` is
   * the only place that decision is made, so consumers never each invent their own fallback.
   */
  it('maps null and undefined to `general`, not to an error', () => {
    expect(resolveSegmentPreset(null)).toBe('general')
    expect(resolveSegmentPreset(undefined)).toBe('general')
  })

  it('passes a real segment through unchanged', () => {
    for (const segment of USER_SEGMENTS) {
      expect(resolveSegmentPreset(segment)).toBe(segment)
    }
  })

  /**
   * `general` is a rendering fallback, never a stored value. If it ever entered `USER_SEGMENTS` it
   * would become selectable in the picker and writable to the column, and "not chosen" and "chose
   * the generic one" would stop being distinguishable.
   */
  it('keeps `general` out of the storable enum while inside the preset set', () => {
    expect(SEGMENT_PRESETS).toContain('general')
    expect(USER_SEGMENTS as readonly string[]).not.toContain('general')
    expect(userSegmentSchema.safeParse('general').success).toBe(false)
    expect(SEGMENT_PRESETS).toHaveLength(USER_SEGMENTS.length + 1)
  })
})

describe('parseUserSegment', () => {
  it('narrows a valid value and returns null for everything else, without throwing', () => {
    expect(parseUserSegment('hiring')).toBe('hiring')
    for (const bad of ['nope', null, undefined, 42, {}, []]) {
      expect(parseUserSegment(bad)).toBeNull()
    }
  })
})

describe('sources', () => {
  it('covers every way a segment can be set', () => {
    expect(SEGMENT_SOURCES).toEqual(['onboarding', 'settings', 'landing', 'migration'])
    expect(segmentSourceSchema.safeParse('api').success).toBe(false)
  })
})

describe('copy', () => {
  /**
   * The spec requires human names rather than internal enums in the interface. A missing entry
   * would render as the raw value and look like a bug in the product rather than a gap here.
   *
   * This deliberately does *not* assert that a label differs from its enum value: "Building" is
   * both, and is the right word. What it asserts is that every entry exists, reads as prose
   * (capitalised, and a description that is a sentence rather than a word), and that the map covers
   * the taxonomy exactly — a segment added without copy is the failure worth catching.
   */
  it('exists for every segment and reads as prose', () => {
    for (const segment of USER_SEGMENTS) {
      const copy = USER_SEGMENT_COPY[segment]
      expect(copy.label[0]).toBe(copy.label[0]?.toUpperCase())
      expect(copy.description).toMatch(/^[A-Z].*\.$/s)
      expect(copy.description.split(' ').length).toBeGreaterThan(4)
    }
    expect(Object.keys(USER_SEGMENT_COPY).sort()).toEqual([...USER_SEGMENTS].sort())
  })

  /**
   * The one promise the interface must make. It lives beside the contract so the settings panel,
   * the onboarding step and the API docs cannot drift into three different reassurances.
   */
  it('states that the segment changes suggestions and not access', () => {
    expect(SEGMENT_SCOPE_NOTICE).toMatch(/permissions/i)
    expect(SEGMENT_SCOPE_NOTICE).toMatch(/plan/i)
    expect(SEGMENT_SCOPE_NOTICE).toMatch(/never deletes/i)
  })
})
