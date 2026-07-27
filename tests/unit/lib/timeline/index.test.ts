import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/timeline/fetchers/github', () => ({ fetchGithubEvents: vi.fn() }))

const { fetchGithubEvents } = await import('~/lib/timeline/fetchers/github')
const { getBuilderTimeline } = await import('~/lib/timeline/index')

const EVENT = {
  id: 'github:1',
  type: 'repo' as const,
  source: 'github' as const,
  title: 'Pushed 1 commit to foo/bar',
  url: 'https://github.com/foo/bar',
  timestamp: new Date().toISOString(),
}

describe('getBuilderTimeline', () => {
  beforeEach(() => {
    vi.mocked(fetchGithubEvents).mockReset()
  })

  it('fetches, normalizes, and caches events for a supported source', async () => {
    vi.mocked(fetchGithubEvents).mockResolvedValue([EVENT])
    const result = await getBuilderTimeline({ source: 'github', sourceId: `u-${Math.random()}`, username: 'octocat' })
    expect(result.supported).toBe(true)
    expect(result.events).toHaveLength(1)
  })

  it('serves a second call from the in-memory cache without refetching', async () => {
    vi.mocked(fetchGithubEvents).mockResolvedValue([EVENT])
    const ref = { source: 'github' as const, sourceId: `u-${Math.random()}`, username: 'octocat' }
    await getBuilderTimeline(ref)
    await getBuilderTimeline(ref)
    expect(fetchGithubEvents).toHaveBeenCalledTimes(1)
  })

  it('returns supported: false for an unsupported source without calling any fetcher', async () => {
    const result = await getBuilderTimeline({ source: 'npm', sourceId: `u-${Math.random()}`, username: 'left-pad' })
    expect(result).toMatchObject({ supported: false, events: [], source: 'npm' })
    expect(fetchGithubEvents).not.toHaveBeenCalled()
  })

  it('returns an empty-but-supported result when the fetcher yields nothing', async () => {
    vi.mocked(fetchGithubEvents).mockResolvedValue([])
    const result = await getBuilderTimeline({ source: 'github', sourceId: `u-${Math.random()}`, username: 'ghost' })
    expect(result).toMatchObject({ supported: true, events: [] })
  })
})
