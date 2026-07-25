import { describe, it, expect } from 'vitest'
import {
  buildTeamAggregate,
  computeSynergyBaseline,
  codeStyleFingerprintV2Schema,
  type TeamMemberRow,
  type CodeStyleMetrics,
} from './synergy'

function row(overrides: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return { language: 'TypeScript', topics: ['web'], followersCount: 100, privateMetadata: {}, ...overrides }
}

describe('buildTeamAggregate', () => {
  it('aggregates language shares, top topics, and paradigm distribution', () => {
    const rows: TeamMemberRow[] = [
      row({ language: 'Rust', topics: ['async', 'systems'] }),
      row({ language: 'Rust', topics: ['async', 'wasm'] }),
      row({ language: 'Python', topics: ['ml'] }),
    ]
    const aggregate = buildTeamAggregate(rows)
    expect(aggregate.size).toBe(3)
    expect(aggregate.languages[0]).toEqual({ name: 'Rust', share: 2 / 3 })
    expect(aggregate.topTopics).toContain('async')
    expect(aggregate.paradigms.functional).toBeGreaterThan(0)
  })

  it('handles a mixed v1/v2 team — v2 fingerprint used when schema-valid, v1 heuristic otherwise', () => {
    const v2Fingerprint = {
      version: 2,
      metrics: {
        paradigm: 'oop',
        modularityScore: 95,
        testIntensity: 95,
        documentationRatio: 95,
        complexityControl: 95,
        namingConsistency: 95,
      },
      generatedAt: new Date().toISOString(),
    }
    expect(codeStyleFingerprintV2Schema.safeParse(v2Fingerprint).success).toBe(true)

    const rows: TeamMemberRow[] = [
      row({ language: 'Java', privateMetadata: { codeStyleFingerprint: v2Fingerprint } }),
      row({ language: 'Java', privateMetadata: {} }), // falls back to v1 heuristic
    ]
    const aggregate = buildTeamAggregate(rows)
    expect(aggregate.aiFingerprintShare).toBe(0.5)
    // v2 member's very high modularityScore (95) should pull the mean up
    // above the v1-only Java heuristic value (75, per code-style.ts).
    expect(aggregate.metricMeans.modularityScore).toBeGreaterThan(75)
  })

  it('omits seniorityMix when fewer than 3 members have enrichment', () => {
    const rows: TeamMemberRow[] = [
      row({ privateMetadata: { aiEnrichment: { estimatedSeniority: 'senior' } } }),
      row({ privateMetadata: { aiEnrichment: { estimatedSeniority: 'mid' } } }),
      row({ privateMetadata: {} }),
    ]
    expect(buildTeamAggregate(rows).seniorityMix).toBeNull()
  })

  it('includes seniorityMix once >= 3 members have enrichment', () => {
    const rows: TeamMemberRow[] = [
      row({ privateMetadata: { aiEnrichment: { estimatedSeniority: 'senior' } } }),
      row({ privateMetadata: { aiEnrichment: { estimatedSeniority: 'senior' } } }),
      row({ privateMetadata: { aiEnrichment: { estimatedSeniority: 'mid' } } }),
    ]
    const aggregate = buildTeamAggregate(rows)
    expect(aggregate.seniorityMix).not.toBeNull()
    expect(aggregate.seniorityMix?.senior).toBeCloseTo(2 / 3)
  })

  it('caps the aggregate at 50 members', () => {
    const rows: TeamMemberRow[] = Array.from({ length: 75 }, () => row())
    expect(buildTeamAggregate(rows).size).toBe(50)
  })

  it('handles an empty team (no crash, zeroed aggregate)', () => {
    const aggregate = buildTeamAggregate([])
    expect(aggregate.size).toBe(0)
    expect(aggregate.languages).toEqual([])
    expect(aggregate.aiFingerprintShare).toBe(0)
  })

  it('handles a team with no enrichment at all — seniorityMix stays null', () => {
    const rows: TeamMemberRow[] = [row(), row(), row(), row()]
    expect(buildTeamAggregate(rows).seniorityMix).toBeNull()
  })
})

describe('computeSynergyBaseline', () => {
  const baseMetricMeans: Omit<CodeStyleMetrics, 'paradigm'> = {
    modularityScore: 50,
    testIntensity: 50,
    documentationRatio: 50,
    complexityControl: 50,
    namingConsistency: 50,
  }

  const team = {
    size: 5,
    languages: [{ name: 'TypeScript', share: 0.6 }],
    topTopics: ['web', 'react', 'graphql'],
    paradigms: { pragmatic: 0.8, oop: 0.2 },
    metricMeans: baseMetricMeans,
    seniorityMix: null,
    aiFingerprintShare: 0,
  }

  it('clamps the score to [0, 100] even with maximal contributions', () => {
    const candidate = {
      language: 'TypeScript',
      topics: ['web', 'react', 'graphql'],
      fingerprint: {
        paradigm: 'oop' as const,
        modularityScore: 100,
        testIntensity: 100,
        documentationRatio: 100,
        complexityControl: 100,
        namingConsistency: 100,
      },
    }
    const result = computeSynergyBaseline(candidate, team)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.notes.length).toBeLessThanOrEqual(6)
  })

  it('scores exactly 0 for a candidate contributing nothing on any component', () => {
    const candidate = {
      language: null,
      topics: [],
      fingerprint: {
        paradigm: 'pragmatic' as const,
        ...baseMetricMeans, // exactly at team mean — no complementary gap
      },
    }
    const emptyTeam = { ...team, languages: [], topTopics: [], paradigms: {} }
    const result = computeSynergyBaseline(candidate, emptyTeam)
    expect(result.score).toBe(0)
  })

  it('is monotonic in gap size: a candidate with a larger complementary gap never scores lower', () => {
    const smallGapCandidate = {
      language: null,
      topics: [],
      fingerprint: { paradigm: 'pragmatic' as const, ...baseMetricMeans, modularityScore: 60 },
    }
    const largeGapCandidate = {
      language: null,
      topics: [],
      fingerprint: { paradigm: 'pragmatic' as const, ...baseMetricMeans, modularityScore: 90 },
    }
    const neutralTeam = { ...team, languages: [], paradigms: {}, topTopics: [] }
    const smallResult = computeSynergyBaseline(smallGapCandidate, neutralTeam)
    const largeResult = computeSynergyBaseline(largeGapCandidate, neutralTeam)
    expect(largeResult.score).toBeGreaterThanOrEqual(smallResult.score)
  })

  it('awards the language bridge bonus only when the shared language covers >= 20% of the team', () => {
    const candidate = {
      language: 'Rust',
      topics: [],
      fingerprint: { paradigm: 'pragmatic' as const, ...baseMetricMeans },
    }
    const thinCoverageTeam = { ...team, languages: [{ name: 'Rust', share: 0.1 }], paradigms: {}, topTopics: [] }
    const strongCoverageTeam = { ...team, languages: [{ name: 'Rust', share: 0.5 }], paradigms: {}, topTopics: [] }
    expect(computeSynergyBaseline(candidate, thinCoverageTeam).score).toBe(0)
    expect(computeSynergyBaseline(candidate, strongCoverageTeam).score).toBe(20)
  })

  it('scores a minority-but-present paradigm higher than a majority-fit paradigm', () => {
    const candidate = {
      language: null,
      topics: [],
      fingerprint: { paradigm: 'oop' as const, ...baseMetricMeans },
    }
    const minorityTeam = { ...team, languages: [], topTopics: [], paradigms: { pragmatic: 0.8, oop: 0.2 } }
    const majorityTeam = { ...team, languages: [], topTopics: [], paradigms: { oop: 0.9, pragmatic: 0.1 } }
    const minorityResult = computeSynergyBaseline(candidate, minorityTeam)
    const majorityResult = computeSynergyBaseline(candidate, majorityTeam)
    expect(minorityResult.score).toBeGreaterThan(majorityResult.score)
    expect(minorityResult.notes.some((n) => n.includes('diversity'))).toBe(true)
  })

  it('notes friction when the candidate\'s paradigm is entirely absent from the team', () => {
    const candidate = {
      language: null,
      topics: [],
      fingerprint: { paradigm: 'functional' as const, ...baseMetricMeans },
    }
    const noFunctionalTeam = { ...team, languages: [], topTopics: [], paradigms: { pragmatic: 1 } }
    const result = computeSynergyBaseline(candidate, noFunctionalTeam)
    expect(result.notes.some((n) => n.includes('friction') || n.includes('possible friction'))).toBe(true)
  })

  it('caps notes at 6', () => {
    const candidate = {
      language: 'TypeScript',
      topics: ['web', 'react', 'graphql'],
      fingerprint: {
        paradigm: 'oop' as const,
        modularityScore: 100,
        testIntensity: 100,
        documentationRatio: 100,
        complexityControl: 100,
        namingConsistency: 100,
      },
    }
    const result = computeSynergyBaseline(candidate, team)
    expect(result.notes.length).toBeLessThanOrEqual(6)
  })
})
