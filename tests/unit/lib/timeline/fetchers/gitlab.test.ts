import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGitlabEvents, mapGitlabEvent } from '~/lib/timeline/fetchers/gitlab'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const projectUrl = 'https://gitlab.com/acme/widgets'

describe('mapGitlabEvent', () => {
  it('maps a push event', () => {
    const result = mapGitlabEvent({
      id: 1,
      project_id: 1,
      action_name: 'pushed to',
      created_at: '2026-01-01T00:00:00Z',
      push_data: { commit_count: 2, commit_title: 'fix stuff' },
    }, projectUrl)
    expect(result).toEqual({
      id: 'gitlab:1',
      type: 'repo',
      source: 'gitlab',
      title: 'Pushed 2 commits to acme/widgets',
      description: 'fix stuff',
      url: projectUrl,
      timestamp: '2026-01-01T00:00:00Z',
    })
  })

  it('returns null when the project URL could not be resolved', () => {
    expect(mapGitlabEvent({ id: 1, project_id: 1, action_name: 'pushed to', created_at: '2026-01-01T00:00:00Z', push_data: { commit_count: 1 } }, null)).toBeNull()
  })

  it('returns null for a zero-commit push', () => {
    expect(mapGitlabEvent({ id: 1, project_id: 1, action_name: 'pushed to', created_at: '2026-01-01T00:00:00Z', push_data: { commit_count: 0 } }, projectUrl)).toBeNull()
  })

  it('maps a project-created event', () => {
    const result = mapGitlabEvent({ id: 2, project_id: 1, action_name: 'created', created_at: '2026-01-02T00:00:00Z' }, projectUrl)
    expect(result?.type).toBe('repo')
    expect(result?.title).toBe('Created acme/widgets')
  })

  it('maps an opened merge request', () => {
    const result = mapGitlabEvent({
      id: 3,
      project_id: 1,
      action_name: 'opened',
      target_type: 'MergeRequest',
      target_iid: 5,
      target_title: 'Add feature',
      created_at: '2026-01-03T00:00:00Z',
    }, projectUrl)
    expect(result?.type).toBe('pr')
    expect(result?.url).toBe(`${projectUrl}/-/merge_requests/5`)
  })

  it('ignores Issue activity', () => {
    expect(mapGitlabEvent({ id: 4, project_id: 1, action_name: 'closed', target_type: 'Issue', created_at: '2026-01-04T00:00:00Z' }, projectUrl)).toBeNull()
  })
})

describe('fetchGitlabEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches events and resolves project urls', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([
        { id: 1, project_id: 9, action_name: 'created', created_at: '2026-01-01T00:00:00Z' },
      ]))
      .mockResolvedValueOnce(jsonResponse({ web_url: projectUrl }))
    vi.stubGlobal('fetch', fetchMock)

    const events = await fetchGitlabEvents({ sourceId: '42' })
    expect(events).toHaveLength(1)
    expect(events[0].url).toBe(projectUrl)
  })

  it('returns [] on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    expect(await fetchGitlabEvents({ sourceId: '42' })).toEqual([])
  })

  it('returns [] on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect(await fetchGitlabEvents({ sourceId: '42' })).toEqual([])
  })
})
