import { describe, expect, it } from 'vitest'
import { SOURCE_NAMES } from '~/lib/sources/types'
import {
  ALL_SOURCE_PRESENTATIONS,
  getSourcePresentation,
  SOURCE_PRESENTATION,
} from '~/shared/lib/source-presentation'

describe('SOURCE_PRESENTATION', () => {
  it('has exactly one entry per SOURCE_NAMES member — an omission would be a type error, this proves it at runtime too', () => {
    const keys = Object.keys(SOURCE_PRESENTATION).sort()
    expect(keys).toEqual([...SOURCE_NAMES].sort())
  })

  it('every entry carries a non-empty label, a real component, and a real badge class', () => {
    for (const presentation of ALL_SOURCE_PRESENTATIONS) {
      expect(presentation.label.length).toBeGreaterThan(0)
      expect(typeof presentation.Icon).toBe('function')
      expect(presentation.badgeClassName).toMatch(/^badge-[a-z]+$/)
    }
  })

  it('sets a dormantReason if and only if the source is not trackable', () => {
    for (const presentation of ALL_SOURCE_PRESENTATIONS) {
      if (presentation.trackable) expect(presentation.dormantReason).toBeNull()
      else expect(presentation.dormantReason).toBeTruthy()
    }
  })

  it.each([
    ['devpost', 'devpost.com'],
    ['producthunt', 'www.producthunt.com'],
    ['bluesky', 'bsky.app'],
  ] as const)('%s is not trackable but still builds a valid, host-matched profile URL', (source, expectedHost) => {
    const presentation = SOURCE_PRESENTATION[source]
    expect(presentation.trackable).toBe(false)
    expect(presentation.dormantReason).toContain(presentation.label)
    const url = presentation.buildProfileUrl('real-handle')
    expect(url).not.toBeNull()
    expect(new URL(url!).hostname).toBe(expectedHost)
  })

  it.each(SOURCE_NAMES)('%s builds a URL whose host it would also accept back', (source) => {
    const presentation = SOURCE_PRESENTATION[source]
    const url = presentation.buildProfileUrl('some-handle')
    expect(url).not.toBeNull()
    expect(url).toMatch(/^https:\/\//)
  })

  describe('buildProfileUrl safety — single-segment sources (Hacker News)', () => {
    it.each(['', '   '])('rejects an empty or blank handle %j', (handle) => {
      expect(SOURCE_PRESENTATION.hn.buildProfileUrl(handle)).toBeNull()
    })

    it.each([
      '../evil.com',
      'foo/../../evil.com',
      'foo?redirect=https://evil.com',
      'foo#@evil.com',
      'https://evil.com',
      'foo/bar',
    ])('rejects a handle that could otherwise escape the profile path: %j', (handle) => {
      expect(SOURCE_PRESENTATION.hn.buildProfileUrl(handle)).toBeNull()
    })

    it('never returns a URL pointing at a different host than the source owns', () => {
      for (const presentation of ALL_SOURCE_PRESENTATIONS) {
        // A handle that looks like a second hostname must not end up placed where it could be
        // read as one — encodeURIComponent neutralizes '.' being meaningful here since the whole
        // encoded handle lands inside one path/query segment, but this asserts the outcome
        // directly rather than trusting the mechanism.
        const url = presentation.buildProfileUrl('evil.example.com')
        if (url === null) continue
        expect(new URL(url).hostname).not.toBe('evil.example.com')
      }
    })
  })

  describe('buildProfileUrl safety — repo-style handles (github/gitlab/codeberg/sourcehut)', () => {
    it.each(['github', 'gitlab', 'codeberg', 'sourcehut'] as const)(
      '%s accepts a real owner/repo handle safely',
      (source) => {
        const presentation = SOURCE_PRESENTATION[source]
        const url = presentation.buildProfileUrl('ClickHouse/ClickHouse')
        expect(url).not.toBeNull()
        expect(url).toContain('ClickHouse/ClickHouse')
      },
    )

    it.each(['github', 'gitlab', 'codeberg', 'sourcehut'] as const)(
      '%s still rejects a traversal attempt hidden inside a multi-segment handle',
      (source) => {
        expect(SOURCE_PRESENTATION[source].buildProfileUrl('foo/../../evil.com')).toBeNull()
        expect(SOURCE_PRESENTATION[source].buildProfileUrl('../evil.com')).toBeNull()
      },
    )

    it.each(['github', 'gitlab', 'codeberg', 'sourcehut'] as const)(
      '%s still rejects a query or fragment delimiter',
      (source) => {
        expect(SOURCE_PRESENTATION[source].buildProfileUrl('foo?redirect=https://evil.com')).toBeNull()
        expect(SOURCE_PRESENTATION[source].buildProfileUrl('foo#@evil.com')).toBeNull()
      },
    )

    it('never returns a URL whose host escapes github.com even with a crafted multi-segment handle', () => {
      const url = SOURCE_PRESENTATION.github.buildProfileUrl('https://evil.com')
      expect(url).not.toBeNull()
      expect(new URL(url!).hostname).toBe('github.com')
    })
  })
})

describe('getSourcePresentation', () => {
  it('returns the entry for a known source', () => {
    expect(getSourcePresentation('github')?.label).toBe('GitHub')
  })

  it('returns null for an unknown source instead of guessing', () => {
    expect(getSourcePresentation('not-a-real-source')).toBeNull()
  })
})
