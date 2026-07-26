import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGithubEvents, mapGithubEvent } from './github'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const repo = { name: 'octocat/hello-world', url: 'https://api.github.com/repos/octocat/hello-world' }

describe('mapGithubEvent', () => {
  it('maps a PushEvent', () => {
    const result = mapGithubEvent({
      id: '1',
      type: 'PushEvent',
      repo,
      created_at: '2026-01-01T00:00:00Z',
      payload: { size: 3, commits: [{ message: 'fix bug' }] },
    })
    expect(result).toEqual({
      id: 'github:1',
      type: 'repo',
      source: 'github',
      title: 'Pushed 3 commits to octocat/hello-world',
      description: 'fix bug',
      url: 'https://github.com/octocat/hello-world',
      timestamp: '2026-01-01T00:00:00Z',
    })
  })

  it('drops a PushEvent with zero commits', () => {
    expect(mapGithubEvent({ id: '1', type: 'PushEvent', repo, created_at: '2026-01-01T00:00:00Z', payload: { size: 0 } })).toBeNull()
  })

  it('maps a CreateEvent for a repository', () => {
    const result = mapGithubEvent({
      id: '2',
      type: 'CreateEvent',
      repo,
      created_at: '2026-01-02T00:00:00Z',
      payload: { ref_type: 'repository' },
    })
    expect(result?.type).toBe('repo')
    expect(result?.title).toBe('Created octocat/hello-world')
  })

  it('ignores a CreateEvent for a branch/tag', () => {
    expect(mapGithubEvent({ id: '2', type: 'CreateEvent', repo, created_at: '2026-01-02T00:00:00Z', payload: { ref_type: 'branch' } })).toBeNull()
  })

  it('maps a ReleaseEvent', () => {
    const result = mapGithubEvent({
      id: '3',
      type: 'ReleaseEvent',
      repo,
      created_at: '2026-01-03T00:00:00Z',
      payload: { release: { tag_name: 'v1.0.0', html_url: 'https://github.com/octocat/hello-world/releases/v1.0.0', name: 'v1.0.0' } },
    })
    expect(result?.type).toBe('release')
    expect(result?.url).toBe('https://github.com/octocat/hello-world/releases/v1.0.0')
  })

  it('maps an opened PullRequestEvent that includes a title/html_url', () => {
    const result = mapGithubEvent({
      id: '4',
      type: 'PullRequestEvent',
      repo,
      created_at: '2026-01-04T00:00:00Z',
      payload: { action: 'opened', pull_request: { title: 'Add feature', html_url: 'https://github.com/octocat/hello-world/pull/1' } },
    })
    expect(result?.type).toBe('pr')
    expect(result?.title).toBe('Opened PR: Add feature')
    expect(result?.url).toBe('https://github.com/octocat/hello-world/pull/1')
  })

  // Verified live against the real GitHub API: /users/{username}/events/public
  // sends a stripped `pull_request` object — only url/id/number/head/base,
  // never `title`/`html_url`/`body` (unlike the full Pull Requests API used
  // elsewhere in this codebase). Without this fallback every PR event on
  // every profile rendered as the blank "Opened PR:" linking to the repo
  // instead of the actual pull request.
  it('falls back to number + repo name when the feed omits title/html_url', () => {
    const result = mapGithubEvent({
      id: '4',
      type: 'PullRequestEvent',
      repo,
      created_at: '2026-01-04T00:00:00Z',
      payload: {
        action: 'opened',
        number: 7,
        pull_request: { number: 7, url: 'https://api.github.com/repos/octocat/hello-world/pulls/7' },
      },
    })
    expect(result?.type).toBe('pr')
    expect(result?.title).toBe('Opened PR #7 in octocat/hello-world')
    expect(result?.url).toBe('https://github.com/octocat/hello-world/pull/7')
  })

  it('ignores a closed PullRequestEvent', () => {
    expect(mapGithubEvent({ id: '4', type: 'PullRequestEvent', repo, created_at: '2026-01-04T00:00:00Z', payload: { action: 'closed' } })).toBeNull()
  })

  it('returns null for an unknown event type', () => {
    expect(mapGithubEvent({ id: '5', type: 'WatchEvent', repo, created_at: '2026-01-05T00:00:00Z', payload: {} })).toBeNull()
  })
})

describe('fetchGithubEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches and maps events, skipping unmappable ones', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([
      { id: '1', type: 'PushEvent', repo, created_at: '2026-01-01T00:00:00Z', payload: { size: 1, commits: [{ message: 'x' }] } },
      { id: '2', type: 'WatchEvent', repo, created_at: '2026-01-01T00:00:00Z', payload: {} },
    ])))
    const events = await fetchGithubEvents({ username: 'octocat' })
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe('github:1')
  })

  it('returns [] on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    expect(await fetchGithubEvents({ username: 'ghost' })).toEqual([])
  })

  it('returns [] on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await fetchGithubEvents({ username: 'octocat' })).toEqual([])
  })

  it('returns [] for a repo-kind username (contains "/") without fetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await fetchGithubEvents({ username: 'octocat/hello-world' })).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
