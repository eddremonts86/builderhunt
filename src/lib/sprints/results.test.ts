import { describe, expect, it } from 'vitest'
import type { ScoredBuilder } from '~/lib/search'
import {
  annotateTrackedResults,
  clipToQuota,
  computeLocationFacets,
  filterSprintResults,
  sortSprintResults,
  toSprintProfileSnapshot,
  type SprintResultRow,
} from './results'

describe('toSprintProfileSnapshot', () => {
  it('strips down to public fields and omits nullish optionals', () => {
    const snapshot = toSprintProfileSnapshot({
      id: 'github:alice',
      kind: 'person',
      source: 'github',
      sourceId: 'alice',
      username: 'alice',
      profileUrl: 'https://github.com/alice',
      topics: ['rust'],
      metadata: { secret: 'never-here' },
      score: 42,
    } as ScoredBuilder)
    expect(snapshot).toEqual({ username: 'alice', profileUrl: 'https://github.com/alice', topics: ['rust'] })
    expect(snapshot).not.toHaveProperty('metadata')
    expect(snapshot).not.toHaveProperty('score')
  })
})

describe('clipToQuota', () => {
  it('keeps everything when there is room', () => {
    const result = clipToQuota(['a', 'b'], 5, 200)
    expect(result).toEqual({ kept: ['a', 'b'], clipped: 0 })
  })

  it('clips when the quota is nearly exhausted', () => {
    const result = clipToQuota(['a', 'b', 'c'], 199, 200)
    expect(result).toEqual({ kept: ['a'], clipped: 2 })
  })

  it('keeps nothing once the quota is already met', () => {
    const result = clipToQuota(['a', 'b'], 200, 200)
    expect(result).toEqual({ kept: [], clipped: 2 })
  })
})

describe('computeLocationFacets', () => {
  it('buckets missing/blank country into an Unknown facet', () => {
    const facets = computeLocationFacets([{ country: 'Berlin' }, { country: '' }, { country: undefined }, { country: 'Berlin' }])
    expect(facets).toEqual([
      { location: 'Berlin', count: 2 },
      { location: 'Unknown', count: 2 },
    ])
  })
})

function makeRow(overrides: Partial<SprintResultRow> = {}): SprintResultRow {
  return {
    id: 'r1',
    source: 'github',
    sourceId: 'alice',
    profile: { username: 'alice', profileUrl: 'https://github.com/alice', topics: ['rust'] },
    matchedVariant: 'Rust broad',
    score: 50,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('sortSprintResults', () => {
  it('sorts by score descending, tie-broken by newest', () => {
    const rows = [makeRow({ id: 'a', score: 10 }), makeRow({ id: 'b', score: 90 })]
    expect(sortSprintResults(rows, 'score').map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('sorts by date descending', () => {
    const rows = [
      makeRow({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeRow({ id: 'new', createdAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(sortSprintResults(rows, 'date').map((r) => r.id)).toEqual(['new', 'old'])
  })
})

describe('filterSprintResults', () => {
  it('matches keywords against bio and topics case-insensitively', () => {
    const rows = [
      makeRow({ id: 'match', profile: { username: 'a', profileUrl: 'x', bio: 'I build WebGL renderers', topics: [] } }),
      makeRow({ id: 'nomatch', profile: { username: 'b', profileUrl: 'y', topics: ['python'] } }),
    ]
    expect(filterSprintResults(rows, { keywords: ['webgl'] }).map((r) => r.id)).toEqual(['match'])
  })

  it('filters by source', () => {
    const rows = [makeRow({ id: 'gh', source: 'github' }), makeRow({ id: 'hn', source: 'hn' })]
    expect(filterSprintResults(rows, { keywords: [], sources: ['hn'] }).map((r) => r.id)).toEqual(['hn'])
  })

  it('filters by minFollowers', () => {
    const rows = [
      makeRow({ id: 'low', profile: { username: 'a', profileUrl: 'x', followersCount: 10, topics: [] } }),
      makeRow({ id: 'high', profile: { username: 'b', profileUrl: 'y', followersCount: 1000, topics: [] } }),
    ]
    expect(filterSprintResults(rows, { keywords: [], minFollowers: 500 }).map((r) => r.id)).toEqual(['high'])
  })
})

describe('annotateTrackedResults', () => {
  it('marks rows present in the tracked key set', () => {
    const rows = [makeRow({ id: 'tracked', source: 'github', sourceId: 'alice' }), makeRow({ id: 'untracked', source: 'hn', sourceId: 'bob' })]
    const annotated = annotateTrackedResults(rows, new Set(['github:alice']))
    expect(annotated.find((r) => r.id === 'tracked')?.tracked).toBe(true)
    expect(annotated.find((r) => r.id === 'untracked')?.tracked).toBe(false)
  })
})
