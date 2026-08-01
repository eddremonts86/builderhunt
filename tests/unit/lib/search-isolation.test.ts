/**
 * plans/phase-1/43-solutions-intelligence Phase 2, "Isolate connectors and correct identity
 * candidates". Verify line: "one/two/all connector failures, same username/different people, same
 * person/different source, stable ordering, timeout, and partial-result tests pass."
 *
 * Before this, `src/lib/search.ts`, `src/lib/dedup.ts` and `src/lib/score.ts` had no unit tests at
 * all, so nothing asserted what happened when a connector threw, hung, or returned garbage — and
 * the answer was: the whole search returned HTTP 500 with zero results from all fifteen sources,
 * because `Promise.all` propagates the first rejection. `github.ts` has no `catch` anywhere and is
 * always the first connector queued, so a GitHub blip alone was enough.
 *
 * The connectors are mocked per case because the property under test is the aggregation contract,
 * not any individual source's parsing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawBuilder } from '~/lib/sources/types'

const mocks = vi.hoisted(() => ({
  github: vi.fn(),
  hn: vi.fn(),
  devto: vi.fn(),
  reddit: vi.fn(),
  lobsters: vi.fn(),
}))

vi.mock('~/lib/sources/github', () => ({ searchGitHub: mocks.github }))
vi.mock('~/lib/sources/hn', () => ({ searchHN: mocks.hn }))
vi.mock('~/lib/sources/devto', () => ({ searchDevTo: mocks.devto }))
vi.mock('~/lib/sources/reddit', () => ({ searchReddit: mocks.reddit }))
vi.mock('~/lib/sources/lobsters', () => ({ searchLobsters: mocks.lobsters }))

// Suppression is a database read; this suite is about aggregation, so it passes everything through.
vi.mock('~/shared/lib/profile-suppression', () => ({ filterSuppressed: (rows: RawBuilder[]) => Promise.resolve(rows) }))
// Redis would make the cache path non-deterministic across cases.
vi.mock('~/shared/lib/redis', () => ({ getRedis: () => Promise.resolve(null) }))

const { CONNECTOR_TIMEOUT_MS, searchBuildersWithStatus } = await import('~/lib/search')

function builder(source: string, sourceId: string, overrides: Partial<RawBuilder> = {}): RawBuilder {
  return {
    id: `${source}-${sourceId}`,
    kind: 'person',
    source,
    sourceId,
    username: sourceId,
    profileUrl: `https://example.test/${source}/${sourceId}`,
    topics: [],
    ...overrides,
  } as RawBuilder
}

/** Distinct keywords per case, so the 5-minute in-memory cache cannot leak between tests. */
let caseId = 0
function freshKeywords(): string[] {
  caseId += 1
  return [`case-${caseId}`]
}

const ALL_FIVE = ['github', 'hn', 'devto', 'reddit', 'lobsters']

beforeEach(() => {
  vi.clearAllMocks()
  // Healthy baseline; each case overrides only the connectors it cares about.
  mocks.github.mockResolvedValue([builder('github', 'gh-1')])
  mocks.hn.mockResolvedValue([builder('hn', 'hn-1')])
  mocks.devto.mockResolvedValue([builder('devto', 'dt-1')])
  mocks.reddit.mockResolvedValue([builder('reddit', 'rd-1')])
  mocks.lobsters.mockResolvedValue([builder('lobsters', 'lb-1')])
})

describe('connector isolation', () => {
  it('returns the other sources when one connector throws', async () => {
    mocks.github.mockRejectedValue(new Error('GitHub 503'))

    const { builders, sources } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })

    // The regression: this used to be a rejection, surfaced by the route as 500 + zero results.
    expect(builders).toHaveLength(4)
    expect(builders.some((b) => b.source === 'github')).toBe(false)
    expect(sources.find((s) => s.source === 'github')?.health).toBe('failed')
    expect(sources.filter((s) => s.health === 'ok')).toHaveLength(4)
  })

  it('returns the other sources when two connectors throw', async () => {
    mocks.github.mockRejectedValue(new Error('GitHub 503'))
    mocks.reddit.mockRejectedValue(new Error('Reddit 429'))

    const { builders, sources } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })

    expect(builders).toHaveLength(3)
    expect(sources.filter((s) => s.health === 'failed').map((s) => s.source).sort()).toEqual(['github', 'reddit'])
  })

  it('resolves with an empty result set — not a rejection — when every connector fails', async () => {
    for (const mock of Object.values(mocks)) mock.mockRejectedValue(new Error('down'))

    const { builders, sources } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })

    // "Nothing worked" must still be a well-formed answer the UI can explain, not a thrown error.
    expect(builders).toEqual([])
    expect(sources.every((s) => s.health === 'failed')).toBe(true)
  })

  it('never leaks an upstream error message into the response detail', async () => {
    mocks.github.mockRejectedValue(new Error('token abc123 rejected by https://api.github.com'))

    const { sources } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })

    const github = sources.find((s) => s.source === 'github')
    expect(github?.detail).toBe('Source unavailable')
    expect(JSON.stringify(sources)).not.toContain('abc123')
  })

  it('reports a hanging connector as a timeout and still returns the rest', async () => {
    vi.useFakeTimers()
    try {
      // Never settles — the pre-fix behaviour was to wait on this until the socket died.
      mocks.github.mockReturnValue(new Promise<RawBuilder[]>(() => {}))

      const pending = searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })
      await vi.advanceTimersByTimeAsync(CONNECTOR_TIMEOUT_MS + 1)
      const { builders, sources } = await pending

      expect(sources.find((s) => s.source === 'github')?.health).toBe('timeout')
      expect(builders).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops malformed records instead of passing them into dedup and scoring', async () => {
    mocks.github.mockResolvedValue([
      builder('github', 'gh-good'),
      { nonsense: true },                                   // no source/sourceId/username at all
      { source: 'github', sourceId: '', username: 'x', topics: [] }, // empty id breaks the dedup key
      null,
    ])

    const { builders, sources } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })

    const githubResults = builders.filter((b) => b.source === 'github')
    expect(githubResults).toHaveLength(1)
    expect(githubResults[0].sourceId).toBe('gh-good')
    // The source did answer, so it is healthy — it just had one usable row.
    expect(sources.find((s) => s.source === 'github')?.resultCount).toBe(1)
  })

  it('reports a source that answers with zero results as ok, not failed', async () => {
    mocks.devto.mockResolvedValue([])

    const { sources } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })

    const devto = sources.find((s) => s.source === 'devto')
    // "Found nothing" and "broke" are different facts, and the old flat response could express neither.
    expect(devto?.health).toBe('ok')
    expect(devto?.resultCount).toBe(0)
  })
})

describe('identity candidates', () => {
  it('keeps two different people who share a username on different sources', async () => {
    mocks.github.mockResolvedValue([builder('github', 'alice', { username: 'alice', followersCount: 5000 })])
    mocks.hn.mockResolvedValue([builder('hn', 'alice', { username: 'alice', followersCount: 3 })])

    const { builders } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })

    const alices = builders.filter((b) => b.username === 'alice')
    // The regression: the dedup key was the bare lowercased username, so these two collapsed into
    // one record — carrying the GitHub follower count, and scored under GitHub's curve because
    // GitHub is queued first. One real person also disappeared from results entirely.
    expect(alices).toHaveLength(2)
    expect(alices.map((b) => b.source).sort()).toEqual(['github', 'hn'])
    expect(alices.find((b) => b.source === 'hn')?.followersCount).toBe(3)
  })

  it('still merges the same account returned twice by one source', async () => {
    mocks.github.mockResolvedValue([
      builder('github', 'gh-1', { topics: ['rust'], followersCount: 10 }),
      builder('github', 'gh-1', { topics: ['wasm'], followersCount: 40, bio: 'Systems' }),
    ])

    const { builders } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ['github'] })

    expect(builders).toHaveLength(1)
    expect(builders[0].followersCount).toBe(40)
    expect([...builders[0].topics].sort()).toEqual(['rust', 'wasm'])
    expect(builders[0].bio).toBe('Systems')
  })
})

describe('score fusion', () => {
  it('does not let one source monopolise the ranking through larger raw magnitudes', async () => {
    // GitHub publishes stargazer counts in the tens of thousands; HN publishes submission counts in
    // the tens. Under a single global sort on the absolute score, GitHub's whole page outranked
    // every other source's best result structurally, regardless of relevance.
    mocks.github.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => builder('github', `gh-${i}`, { followersCount: 90_000 - i * 100 })),
    )
    mocks.hn.mockResolvedValue([builder('hn', 'hn-top', { followersCount: 20 })])

    const { builders } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ['github', 'hn'] })

    const hnPosition = builders.findIndex((b) => b.source === 'hn')
    expect(hnPosition).toBeGreaterThanOrEqual(0)
    // Each source's own #1 fuses to the same reciprocal rank, so HN's best lands adjacent to
    // GitHub's best rather than behind all five of them.
    expect(hnPosition).toBeLessThanOrEqual(1)
  })

  it('keeps the absolute per-source score alongside the fused one', async () => {
    const { builders } = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ALL_FIVE })

    // Both are needed: `score` is what the UI shows, `fusedScore` is what the ordering means.
    expect(builders.every((b) => typeof b.score === 'number')).toBe(true)
    expect(builders.every((b) => typeof b.fusedScore === 'number' && b.fusedScore > 0)).toBe(true)
  })

  it('orders identically across repeated identical searches', async () => {
    // Ties used to be resolved by whatever order `Array.prototype.sort` happened to leave them in,
    // which makes paging drop and repeat rows between requests.
    const tied = Array.from({ length: 6 }, (_, i) => builder('github', `tie-${i}`, { followersCount: 100 }))
    mocks.github.mockResolvedValue(tied)

    const first = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ['github'] })
    const second = await searchBuildersWithStatus({ keywords: freshKeywords(), sources: ['github'] })

    expect(first.builders.map((b) => b.sourceId)).toEqual(second.builders.map((b) => b.sourceId))
  })
})
