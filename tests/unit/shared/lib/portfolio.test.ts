import { describe, expect, it } from 'vitest'
import {
  buildPublicPortfolio,
  mergePortfolioDraft,
  parsePortfolioSettings,
  publishPortfolio,
  selectPortfolioProjects,
  unpublishPortfolio,
  UNPUBLISHED_PORTFOLIO,
  type PortfolioProject,
} from '~/shared/lib/portfolio'

describe('parsePortfolioSettings', () => {
  it('returns the unpublished default for null/undefined', () => {
    expect(parsePortfolioSettings(null)).toEqual(UNPUBLISHED_PORTFOLIO)
    expect(parsePortfolioSettings(undefined)).toEqual(UNPUBLISHED_PORTFOLIO)
  })

  it('fails closed on a corrupt/future-shaped stored value instead of throwing', () => {
    expect(parsePortfolioSettings({ theme: 'not-a-real-theme', published: 'yes' })).toEqual(UNPUBLISHED_PORTFOLIO)
    expect(parsePortfolioSettings('a plain string, not an object')).toEqual(UNPUBLISHED_PORTFOLIO)
  })

  it('accepts a valid stored value as-is', () => {
    const valid = { ...UNPUBLISHED_PORTFOLIO, headline: 'Ships Rust CLIs', published: true, publishedAt: '2026-01-01T00:00:00.000Z' }
    expect(parsePortfolioSettings(valid)).toEqual(valid)
  })
})

describe('mergePortfolioDraft', () => {
  it('merges input over existing and stamps updatedAt', () => {
    const now = '2026-07-26T00:00:00.000Z'
    const merged = mergePortfolioDraft(UNPUBLISHED_PORTFOLIO, { headline: 'New headline' }, now)
    expect(merged.headline).toBe('New headline')
    expect(merged.updatedAt).toBe(now)
    expect(merged.published).toBe(false)
  })

  it('never sets published/publishedAt from a draft merge', () => {
    const now = '2026-07-26T00:00:00.000Z'
    const merged = mergePortfolioDraft(UNPUBLISHED_PORTFOLIO, { headline: 'x' }, now)
    expect(merged.published).toBe(false)
    expect(merged.publishedAt).toBeNull()
  })
})

describe('publishPortfolio / unpublishPortfolio', () => {
  it('publish sets published + publishedAt on first publish', () => {
    const now = '2026-07-26T00:00:00.000Z'
    const published = publishPortfolio(UNPUBLISHED_PORTFOLIO, now)
    expect(published.published).toBe(true)
    expect(published.publishedAt).toBe(now)
  })

  it('repeated publish is idempotent — publishedAt does not move', () => {
    const first = publishPortfolio(UNPUBLISHED_PORTFOLIO, '2026-07-26T00:00:00.000Z')
    const second = publishPortfolio(first, '2026-07-27T00:00:00.000Z')
    expect(second.publishedAt).toBe('2026-07-26T00:00:00.000Z')
  })

  it('unpublish clears published but keeps publishedAt as history', () => {
    const published = publishPortfolio(UNPUBLISHED_PORTFOLIO, '2026-07-26T00:00:00.000Z')
    const unpublished = unpublishPortfolio(published, '2026-07-27T00:00:00.000Z')
    expect(unpublished.published).toBe(false)
    expect(unpublished.publishedAt).toBe('2026-07-26T00:00:00.000Z')
  })
})

describe('selectPortfolioProjects', () => {
  const candidates: PortfolioProject[] = [
    { id: 'a', name: 'repo-a', description: null, url: 'https://x/a', stars: 10, language: 'Rust' },
    { id: 'b', name: 'repo-b', description: null, url: 'https://x/b', stars: 5, language: 'Go' },
    { id: 'c', name: 'repo-c', description: null, url: 'https://x/c', stars: 1, language: null },
  ]

  it('returns projects in the owner-selected order, not candidate order', () => {
    expect(selectPortfolioProjects(candidates, ['c', 'a']).map((p) => p.id)).toEqual(['c', 'a'])
  })

  it('silently drops selected ids that no longer exist among candidates', () => {
    expect(selectPortfolioProjects(candidates, ['a', 'deleted-repo', 'b']).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('returns an empty list when nothing is selected', () => {
    expect(selectPortfolioProjects(candidates, [])).toEqual([])
  })
})

describe('buildPublicPortfolio', () => {
  const base = {
    claimId: 'claim_1',
    source: 'github',
    username: 'octocat',
    displayName: 'The Octocat',
    avatarUrl: 'https://avatars/octocat.png',
    profileUrl: 'https://github.com/octocat',
    projectCandidates: [
      { id: 'a', name: 'repo-a', description: 'A repo', url: 'https://x/a', stars: 10, language: 'Rust' },
    ] as PortfolioProject[],
  }

  it('returns null (not an error) for an unpublished draft — never leaks its existence', () => {
    expect(buildPublicPortfolio({ ...base, settings: UNPUBLISHED_PORTFOLIO })).toBeNull()
  })

  it('returns the full public DTO once published, with only selected projects', () => {
    const settings = publishPortfolio(
      { ...UNPUBLISHED_PORTFOLIO, headline: 'Ships Rust CLIs', selectedProjectIds: ['a'] },
      '2026-07-26T00:00:00.000Z',
    )
    const result = buildPublicPortfolio({ ...base, settings })
    expect(result).not.toBeNull()
    expect(result?.headline).toBe('Ships Rust CLIs')
    expect(result?.projects).toHaveLength(1)
    expect(result?.projects[0].id).toBe('a')
    expect(result?.publishedAt).toBe('2026-07-26T00:00:00.000Z')
  })

  it('never leaks fields outside the public schema (no owner id, no metadata)', () => {
    const settings = publishPortfolio(UNPUBLISHED_PORTFOLIO, '2026-07-26T00:00:00.000Z')
    const result = buildPublicPortfolio({ ...base, settings })
    expect(result && Object.keys(result).sort()).toEqual(
      ['aiPersona', 'avatarUrl', 'claimId', 'displayName', 'headline', 'introduction', 'profileUrl', 'projects', 'publishedAt', 'source', 'theme', 'timeline', 'username'].sort(),
    )
  })

  describe('aiPersona gating (defense in depth — the caller should already gate this on showAiPersona before calling)', () => {
    const persona = {
      summary: 'Ships reliable backend systems with a focus on observability.',
      estimatedSeniority: 'senior' as const,
      primaryFocus: 'distributed systems',
      strengths: ['systems design', 'debugging'],
      codingStyle: 'pragmatic',
      enrichedAt: '2026-07-01T00:00:00.000Z',
      model: 'minimax',
    }

    it('is null when showAiPersona is false, even if an aiPersona was passed in', () => {
      const settings = publishPortfolio({ ...UNPUBLISHED_PORTFOLIO, showAiPersona: false }, '2026-07-26T00:00:00.000Z')
      const result = buildPublicPortfolio({ ...base, settings, aiPersona: persona })
      expect(result?.aiPersona).toBeNull()
    })

    it('is null when showAiPersona is true but no artifact was found', () => {
      const settings = publishPortfolio({ ...UNPUBLISHED_PORTFOLIO, showAiPersona: true }, '2026-07-26T00:00:00.000Z')
      const result = buildPublicPortfolio({ ...base, settings, aiPersona: null })
      expect(result?.aiPersona).toBeNull()
    })

    it('carries the persona when showAiPersona is true and a valid artifact was passed in', () => {
      const settings = publishPortfolio({ ...UNPUBLISHED_PORTFOLIO, showAiPersona: true }, '2026-07-26T00:00:00.000Z')
      const result = buildPublicPortfolio({ ...base, settings, aiPersona: persona })
      expect(result?.aiPersona).toEqual(persona)
    })
  })

  describe('timeline gating (defense in depth — the caller should already gate this on showTimeline before calling)', () => {
    const events = [
      { id: 'evt_1', occurredAt: '2026-07-01T00:00:00.000Z', kind: 'repo', title: 'Pushed to builderhunt', summary: '' },
    ]

    it('is empty when showTimeline is false, even if events were passed in', () => {
      const settings = publishPortfolio({ ...UNPUBLISHED_PORTFOLIO, showTimeline: false }, '2026-07-26T00:00:00.000Z')
      const result = buildPublicPortfolio({ ...base, settings, timeline: events })
      expect(result?.timeline).toEqual([])
    })

    it('is empty when showTimeline is true but no events were found', () => {
      const settings = publishPortfolio({ ...UNPUBLISHED_PORTFOLIO, showTimeline: true }, '2026-07-26T00:00:00.000Z')
      const result = buildPublicPortfolio({ ...base, settings, timeline: [] })
      expect(result?.timeline).toEqual([])
    })

    it('carries the events when showTimeline is true and events were passed in', () => {
      const settings = publishPortfolio({ ...UNPUBLISHED_PORTFOLIO, showTimeline: true }, '2026-07-26T00:00:00.000Z')
      const result = buildPublicPortfolio({ ...base, settings, timeline: events })
      expect(result?.timeline).toEqual(events)
    })
  })
})
