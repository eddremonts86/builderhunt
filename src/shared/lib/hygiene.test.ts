import { describe, it, expect } from 'vitest'
import { computeHygiene, estimateRepoSignalsFromBuilder, hygieneGrade, projectHygieneEnvelopeSchema, type RepoSignals } from './hygiene'

const EXCELLENT: RepoSignals[] = [
  {
    name: 'a',
    stars: 1000,
    openIssues: 5,
    closedIssues: 200,
    hasReadme: true,
    hasContributing: true,
    hasLicense: true,
    hasWorkflows: true,
    averageCloseDays: 2,
    pushedAt: Date.now(),
  },
  {
    name: 'b',
    stars: 500,
    openIssues: 2,
    closedIssues: 100,
    hasReadme: true,
    hasContributing: true,
    hasLicense: true,
    hasWorkflows: true,
    averageCloseDays: 3,
    pushedAt: Date.now(),
  },
]

const POOR: RepoSignals[] = [
  {
    name: 'a',
    stars: 50,
    openIssues: 30,
    closedIssues: 5,
    hasReadme: true,
    hasContributing: false,
    hasLicense: false,
    hasWorkflows: false,
    averageCloseDays: 60,
    pushedAt: Date.now() - 1000 * 24 * 60 * 60 * 1000,
  },
]

describe('computeHygiene', () => {
  it('returns 0 score for empty repos', () => {
    const h = computeHygiene([])
    expect(h.globalScore).toBe(0)
    expect(h.issueCloseRate).toBe(0)
  })

  it('high score for excellent repos', () => {
    const h = computeHygiene(EXCELLENT)
    expect(h.globalScore).toBeGreaterThanOrEqual(85)
    expect(h.issueCloseRate).toBeGreaterThan(90)
    expect(h.hasCICD).toBe(true)
    expect(h.documentationScore).toBe(100)
  })

  it('low score for poor repos', () => {
    const h = computeHygiene(POOR)
    expect(h.globalScore).toBeLessThan(40)
    expect(h.hasCICD).toBe(false)
    expect(h.documentationScore).toBe(0)
  })

  it('issue close rate calculation', () => {
    const repos: RepoSignals[] = [
      { ...EXCELLENT[0], openIssues: 25, closedIssues: 75 },
    ]
    const h = computeHygiene(repos)
    expect(h.issueCloseRate).toBe(75)
  })

  it('documentation score: 100 if all repos have readme+contributing+license', () => {
    expect(computeHygiene(EXCELLENT).documentationScore).toBe(100)
  })

  it('documentation score: 0 if no repos have all three', () => {
    expect(computeHygiene(POOR).documentationScore).toBe(0)
  })

  it('CI/CD: true if any repo has workflows', () => {
    expect(computeHygiene(EXCELLENT).hasCICD).toBe(true)
    expect(computeHygiene(POOR).hasCICD).toBe(false)
  })

  it('handles single repo', () => {
    const h = computeHygiene([EXCELLENT[0]])
    expect(h.globalScore).toBeGreaterThan(0)
  })

  it('lastAnalyzedAt is recent', () => {
    const h = computeHygiene(EXCELLENT)
    expect(h.lastAnalyzedAt).toBeGreaterThan(Date.now() - 1000)
  })

  it('average resolution days is rounded', () => {
    const h = computeHygiene(EXCELLENT)
    expect(Number.isInteger(h.averageResolutionDays)).toBe(true)
  })
})

describe('hygieneGrade', () => {
  it('excellent for 90+', () => {
    expect(hygieneGrade(92).label).toBe('Excellent')
  })
  it('good for 70-84', () => {
    expect(hygieneGrade(75).label).toBe('Good')
  })
  it('average for 50-69', () => {
    expect(hygieneGrade(60).label).toBe('Average')
  })
  it('needs work for <50', () => {
    expect(hygieneGrade(30).label).toBe('Needs work')
  })
})

describe('estimateRepoSignalsFromBuilder', () => {
  it('returns 2+ repos for normal builders', () => {
    const repos = estimateRepoSignalsFromBuilder({ followersCount: 100, topics: ['rust'] })
    expect(repos.length).toBeGreaterThanOrEqual(2)
  })

  it('returns 5 repos for hot builders', () => {
    const repos = estimateRepoSignalsFromBuilder({ followersCount: 5000, topics: ['rust', 'wasm', 'async'] })
    expect(repos.length).toBe(5)
  })

  it('each repo has required fields', () => {
    const repos = estimateRepoSignalsFromBuilder({ followersCount: 100, topics: ['rust'] })
    for (const r of repos) {
      expect(r).toHaveProperty('name')
      expect(r).toHaveProperty('stars')
      expect(r).toHaveProperty('openIssues')
      expect(r).toHaveProperty('closedIssues')
      expect(r).toHaveProperty('hasReadme')
      expect(r).toHaveProperty('hasLicense')
    }
  })

  it('returns identical signals for the same builder across calls (deterministic, no Math.random)', () => {
    const builder = { username: 'octocat', followersCount: 3000, topics: ['rust', 'wasm'], language: 'Rust' }
    const first = estimateRepoSignalsFromBuilder(builder)
    const second = estimateRepoSignalsFromBuilder(builder)
    expect(second.map((r) => ({ ...r, pushedAt: 0 }))).toEqual(first.map((r) => ({ ...r, pushedAt: 0 })))
  })

  it('different builders (or missing username) get different-shaped estimates deterministically too', () => {
    const a = estimateRepoSignalsFromBuilder({ username: 'alice', followersCount: 100, topics: ['go'] })
    const b = estimateRepoSignalsFromBuilder({ username: 'alice', followersCount: 100, topics: ['go'] })
    expect(a).toEqual(b)
  })

  it('uses real repos from metadata when present', () => {
    const repos = estimateRepoSignalsFromBuilder({
      followersCount: 100,
      topics: ['rust'],
      metadata: {
        repos: [
          {
            name: 'real-repo',
            stars: 9999,
            openIssues: 0,
            closedIssues: 100,
            hasReadme: true,
            hasContributing: true,
            hasLicense: true,
            hasWorkflows: true,
            averageCloseDays: 1,
            pushedAt: Date.now(),
          },
        ],
      },
    })
    expect(repos).toHaveLength(1)
    expect(repos[0].name).toBe('real-repo')
    expect(repos[0].stars).toBe(9999)
  })
})

describe('projectHygieneEnvelopeSchema', () => {
  it('round-trips a real computeHygiene result', () => {
    const repos: RepoSignals[] = [{
      name: 'a', stars: 10, openIssues: 1, closedIssues: 9,
      hasReadme: true, hasContributing: true, hasLicense: true, hasWorkflows: true,
      averageCloseDays: 3, pushedAt: Date.now(),
    }]
    const envelope = {
      hygiene: computeHygiene(repos),
      signals: repos,
      computedAt: new Date().toISOString(),
      version: 1 as const,
    }
    const parsed = projectHygieneEnvelopeSchema.parse(envelope)
    expect(parsed).toEqual(envelope)
  })

  it('rejects more than 5 signals', () => {
    const repo: RepoSignals = {
      name: 'a', stars: 1, openIssues: 0, closedIssues: 0,
      hasReadme: false, hasContributing: false, hasLicense: false, hasWorkflows: false,
      averageCloseDays: 0, pushedAt: 0,
    }
    const envelope = {
      hygiene: computeHygiene([repo]),
      signals: Array(6).fill(repo),
      computedAt: new Date().toISOString(),
      version: 1 as const,
    }
    expect(() => projectHygieneEnvelopeSchema.parse(envelope)).toThrow()
  })
})
