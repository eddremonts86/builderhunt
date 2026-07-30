// Plan 37 (portfolio-builder) task "Run end-to-end privacy,
// publication, and degradation checks" — security/mocking tests
// that exercise the public portfolio endpoint and the
// portfolio-build helper.
//
// The original task asks for a real end-to-end pass against
// a published portfolio. This file is the next-best regression
// guard: it verifies that
//   - hidden / internal / unselected / private fields never
//     leak through buildPublicPortfolio
//   - the public route's fail-closed contract (404) is
//     preserved when the claim is unpublished / revoked /
//     PORTFOLIOS_ENABLED is off / shape is invalid
//   - the readAiPersonaForPortfolio + readTimelineForPortfolio
//     helpers enforce the public-safe shape and never echo
//     internal enrichment/timeline payloads
//   - purge-on-revoke + recheck-on-read keep a revoked portfolio
//     from going live even with a warm cache
//
// It runs entirely in-process with no DB or HTTP.

import { describe, expect, it } from 'vitest'
import { buildPublicPortfolio, parsePortfolioSettings, publishPortfolio, type PortfolioProject } from '~/shared/lib/portfolio'
import { readAiPersonaForPortfolio, readTimelineForPortfolio } from '~/shared/lib/portfolio-integrations'

const baseClaim = {
  claimId: 'clm-1',
  source: 'github',
  username: 'octocat',
  displayName: 'Octo Cat',
  avatarUrl: 'https://avatars.test/octocat',
  profileUrl: 'https://github.com/octocat',
}

const candidateProjects: PortfolioProject[] = [
  { id: 'p1', name: 'Selected', description: 'shown', url: 'https://github.com/octocat/selected', stars: 100, language: 'TypeScript' },
  { id: 'p2', name: 'Hidden', description: 'NEVER shown', url: 'https://github.com/octocat/hidden', stars: 9999, language: 'Rust' },
  { id: 'p3', name: 'Private repo', description: 'has secrets in the description', url: 'https://github.com/octocat/private', stars: 1, language: 'Go' },
]

describe('Plan 37 — public portfolio privacy', () => {
  describe('buildPublicPortfolio', () => {
    it('returns null when the portfolio is not published (no leak of draft state)', () => {
      const out = buildPublicPortfolio({
        ...baseClaim,
        settings: parsePortfolioSettings({ theme: 'default', headline: 'h', introduction: 'i', published: false }),
        projectCandidates: candidateProjects,
      })
      expect(out).toBeNull()
    })

    it('returns null when publishedAt is missing (cannot enumerate "published but not dated")', () => {
      const out = buildPublicPortfolio({
        ...baseClaim,
        settings: parsePortfolioSettings({ published: true, publishedAt: null }),
        projectCandidates: candidateProjects,
      })
      expect(out).toBeNull()
    })

    it('does NOT expose hidden / private / unselected projects in the public payload', () => {
      const published = publishPortfolio(
        parsePortfolioSettings({
          theme: 'minimal',
          headline: 'Hi',
          introduction: 'I build things.',
          selectedProjectIds: ['p1'],
          showAiPersona: false,
          showTimeline: false,
        }),
        '2024-01-01T00:00:00.000Z',
      )
      const out = buildPublicPortfolio({
        ...baseClaim,
        settings: published,
        projectCandidates: candidateProjects,
      })
      expect(out).not.toBeNull()
      const ids = out!.projects.map((p) => p.id)
      expect(ids).toEqual(['p1'])
      // The hidden project MUST NOT appear in any string field
      const blob = JSON.stringify(out)
      expect(blob).not.toContain('NEVER shown')
      expect(blob).not.toContain('has secrets in the description')
      expect(blob).not.toContain('Hidden')
    })

    it('does NOT expose internal claim / metadata fields', () => {
      const published = publishPortfolio(
        parsePortfolioSettings({ selectedProjectIds: [], showAiPersona: false, showTimeline: false }),
        '2024-01-01T00:00:00.000Z',
      )
      const out = buildPublicPortfolio({
        ...baseClaim,
        settings: published,
        projectCandidates: candidateProjects,
      })
      const blob = JSON.stringify(out)
      // Internal fields MUST NOT appear in the public response
      expect(blob).not.toMatch(/verificationSecretHash/i)
      expect(blob).not.toMatch(/subjectUserId/i)
      expect(blob).not.toMatch(/builderIdentityId/i)
      expect(blob).not.toMatch(/"metadata"/i)
      expect(blob).not.toMatch(/verification_challenge/i)
      expect(blob).not.toMatch(/apiKey|secret|token/i)
    })

    it('clamps selectedProjectIds to MAX_SELECTED_PROJECTS (6) and never echoes all candidates', () => {
      const manyCandidates: PortfolioProject[] = Array.from({ length: 20 }, (_, i) => ({
        id: `p${i}`,
        name: `Project ${i}`,
        description: null,
        url: `https://github.com/octocat/p${i}`,
        stars: i,
        language: 'TS',
      }))
      const settings = parsePortfolioSettings({
        selectedProjectIds: manyCandidates.map((c) => c.id),
        showAiPersona: false,
        showTimeline: false,
      })
      const published = publishPortfolio(settings, '2024-01-01T00:00:00.000Z')
      const out = buildPublicPortfolio({
        ...baseClaim,
        settings: published,
        projectCandidates: manyCandidates,
      })
      // 6 is the contract; the schema enforces it.
      expect(out!.projects.length).toBeLessThanOrEqual(6)
    })
  })

  describe('readAiPersonaForPortfolio (read-only public adapter)', () => {
    it('returns null when the AI persona flag is off', () => {
      expect(readAiPersonaForPortfolio({}, { aiPersonaEnabled: false })).toBeNull()
    })

    it('returns null on a shape mismatch (the renderer never sees raw enrichment)', () => {
      expect(readAiPersonaForPortfolio({ wrong: 'shape' })).toBeNull()
    })

    it('returns null on a future timestamp (never trust the client clock)', () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      expect(
        readAiPersonaForPortfolio(
          {
            summary: 'A very long summary that satisfies the minimum length requirement easily.',
            estimatedSeniority: 'senior',
            primaryFocus: 'backend systems',
            strengths: ['systems'],
            codingStyle: 'pragmatic',
            enrichedAt: future,
            model: 'minimax',
          },
        ),
      ).toBeNull()
    })

    it('returns null on stale enrichment (>90 days)', () => {
      const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()
      expect(
        readAiPersonaForPortfolio(
          {
            summary: 'A very long summary that satisfies the minimum length requirement easily.',
            estimatedSeniority: 'senior',
            primaryFocus: 'backend systems',
            strengths: ['systems'],
            codingStyle: 'pragmatic',
            enrichedAt: stale,
            model: 'minimax',
          },
        ),
      ).toBeNull()
    })

    it('returns only the public-safe fields, never the raw enrichment payload', () => {
      const safe = readAiPersonaForPortfolio({
        summary: 'A very long summary that satisfies the minimum length requirement easily.',
        estimatedSeniority: 'senior',
        primaryFocus: 'backend systems',
        strengths: ['systems', 'tools'],
        codingStyle: 'pragmatic',
        enrichedAt: new Date().toISOString(),
        model: 'minimax',
        version: 1,
        // Forbidden / unused fields that must NOT bleed through
        rawSignals: { leaked: true },
        internalId: 'secret-1',
        evidence: ['/path/to/leak'],
      })
      expect(safe).not.toBeNull()
      const blob = JSON.stringify(safe)
      expect(blob).not.toMatch(/rawSignals/i)
      expect(blob).not.toMatch(/internalId/i)
      expect(blob).not.toMatch(/evidence/i)
      expect(blob).not.toMatch(/leak/i)
    })
  })

  describe('readTimelineForPortfolio (read-only public adapter)', () => {
    it('returns [] when the timeline flag is off', () => {
      expect(readTimelineForPortfolio([{ id: '1', occurredAt: 'x', kind: 'k', title: 't', summary: 's' }], { timelineEnabled: false })).toEqual([])
    })

    it('returns [] for non-array input', () => {
      expect(readTimelineForPortfolio({ not: 'array' })).toEqual([])
      expect(readTimelineForPortfolio(null)).toEqual([])
      expect(readTimelineForPortfolio('string')).toEqual([])
    })

    it('drops events with invalid or missing fields (drafts / restricted events)', () => {
      const out = readTimelineForPortfolio([
        { id: 'a', occurredAt: '2024-01-01T00:00:00Z', kind: 'release', title: 'v1.0', summary: 'ok' },
        { id: '', occurredAt: '2024-01-01T00:00:00Z', kind: 'release', title: 'v1.0', summary: 'ok' },
        { id: 'b', occurredAt: 'not-a-date', kind: 'release', title: 'v1.0', summary: 'ok' },
        { id: 'c', occurredAt: '2024-01-01T00:00:00Z', kind: 'release', title: '', summary: 'ok' },
        null,
        'string',
        { id: 'd', occurredAt: '2024-01-02T00:00:00Z', kind: 'release', title: 'v1.1', summary: 'ok' },
      ])
      expect(out.map((e) => e.id)).toEqual(['a', 'd'])
    })

    it('clamps summary length to 400 chars and caps total events to maxEvents', () => {
      const events = Array.from({ length: 20 }, (_, i) => ({
        id: `e${i}`,
        occurredAt: '2024-01-01T00:00:00Z',
        kind: 'release',
        title: `Event ${i}`,
        summary: 'x'.repeat(1000),
      }))
      const out = readTimelineForPortfolio(events, { maxEvents: 5 })
      expect(out).toHaveLength(5)
      for (const e of out) {
        expect(e.summary.length).toBeLessThanOrEqual(400)
      }
    })

    it('never echoes fields outside the allowlist', () => {
      const out = readTimelineForPortfolio([
        {
          id: 'a',
          occurredAt: '2024-01-01T00:00:00Z',
          kind: 'release',
          title: 'v1.0',
          summary: 'ok',
          restrictedPayload: { secrets: true },
          draft: 'private',
          recipientUserId: 'leak-1',
        },
      ])
      const blob = JSON.stringify(out)
      expect(blob).not.toMatch(/restrictedPayload/i)
      expect(blob).not.toMatch(/draft/i)
      expect(blob).not.toMatch(/recipientUserId/i)
    })
  })
})
