import { describe, it, expect } from 'vitest'
import { issuesToSignals, docsFromRootListing, selectReposForSignals } from './repo-signals'

describe('issuesToSignals', () => {
  it('returns zeros for an empty payload', () => {
    expect(issuesToSignals([])).toEqual({ openIssues: 0, closedIssues: 0, averageCloseDays: 0 })
  })

  it('filters out pull requests (distinguished by the pull_request key)', () => {
    const result = issuesToSignals([
      { state: 'open', created_at: '2026-01-01T00:00:00Z', closed_at: null, pull_request: {} },
      { state: 'open', created_at: '2026-01-01T00:00:00Z', closed_at: null },
    ])
    expect(result.openIssues).toBe(1)
  })

  it('counts open vs closed issues', () => {
    const result = issuesToSignals([
      { state: 'open', created_at: '2026-01-01T00:00:00Z', closed_at: null },
      { state: 'closed', created_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-05T00:00:00Z' },
      { state: 'closed', created_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-03T00:00:00Z' },
    ])
    expect(result.openIssues).toBe(1)
    expect(result.closedIssues).toBe(2)
  })

  it('computes average close days across closed issues', () => {
    const result = issuesToSignals([
      { state: 'closed', created_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-05T00:00:00Z' }, // 4 days
      { state: 'closed', created_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-03T00:00:00Z' }, // 2 days
    ])
    expect(result.averageCloseDays).toBe(3)
  })

  it('a PR-only list yields zero issues', () => {
    const result = issuesToSignals([
      { state: 'closed', created_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-02T00:00:00Z', pull_request: {} },
    ])
    expect(result).toEqual({ openIssues: 0, closedIssues: 0, averageCloseDays: 0 })
  })
})

describe('docsFromRootListing', () => {
  it('detects README/CONTRIBUTING/LICENSE case-insensitively', () => {
    const result = docsFromRootListing([
      { name: 'README.md' },
      { name: 'CONTRIBUTING.rst' },
      { name: 'LICENSE' },
      { name: 'src' },
    ])
    expect(result).toEqual({ hasReadme: true, hasContributing: true, hasLicense: true })
  })

  it('accepts the British "licence" spelling too', () => {
    expect(docsFromRootListing([{ name: 'LICENCE.txt' }]).hasLicense).toBe(true)
  })

  it('returns all-false for an empty listing', () => {
    expect(docsFromRootListing([])).toEqual({ hasReadme: false, hasContributing: false, hasLicense: false })
  })

  it('returns all-false when none of the three are present', () => {
    expect(docsFromRootListing([{ name: 'src' }, { name: 'package.json' }])).toEqual({
      hasReadme: false,
      hasContributing: false,
      hasLicense: false,
    })
  })
})

describe('selectReposForSignals', () => {
  const repo = (overrides: Partial<{ name: string; fork: boolean; size: number; stargazers_count: number }>) => ({
    name: overrides.name ?? 'r',
    full_name: `owner/${overrides.name ?? 'r'}`,
    fork: overrides.fork ?? false,
    size: overrides.size ?? 100,
    stargazers_count: overrides.stargazers_count ?? 0,
    pushed_at: '2026-01-01T00:00:00Z',
  })

  it('excludes forks', () => {
    const result = selectReposForSignals([repo({ name: 'a', fork: true }), repo({ name: 'b', fork: false })])
    expect(result.map((r) => r.name)).toEqual(['b'])
  })

  it('excludes empty (size 0) repos', () => {
    const result = selectReposForSignals([repo({ name: 'empty', size: 0 }), repo({ name: 'real', size: 10 })])
    expect(result.map((r) => r.name)).toEqual(['real'])
  })

  it('sorts by stars descending and caps at 5', () => {
    const repos = Array.from({ length: 8 }, (_, i) => repo({ name: `r${i}`, stargazers_count: i }))
    const result = selectReposForSignals(repos)
    expect(result).toHaveLength(5)
    expect(result[0].name).toBe('r7')
    expect(result[4].name).toBe('r3')
  })
})
