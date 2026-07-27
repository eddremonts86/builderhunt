import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDevToEvents, mapDevToArticle } from '~/lib/timeline/fetchers/devto'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('mapDevToArticle', () => {
  it('maps an article to an article event', () => {
    const result = mapDevToArticle({
      id: 1,
      title: 'How I built X',
      description: 'A short description',
      url: 'https://dev.to/user/how-i-built-x',
      published_at: '2026-01-01T00:00:00Z',
    })
    expect(result).toEqual({
      id: 'devto:1',
      type: 'article',
      source: 'devto',
      title: 'How I built X',
      description: 'A short description',
      url: 'https://dev.to/user/how-i-built-x',
      timestamp: '2026-01-01T00:00:00Z',
    })
  })

  it('falls back to published_timestamp when published_at is absent', () => {
    const result = mapDevToArticle({ id: 2, title: 'Draft-ish', url: 'https://dev.to/user/x', published_timestamp: '2026-01-02T00:00:00Z' })
    expect(result?.timestamp).toBe('2026-01-02T00:00:00Z')
  })

  it('returns null when neither timestamp field is present', () => {
    expect(mapDevToArticle({ id: 3, title: 'Unpublished', url: 'https://dev.to/user/y' })).toBeNull()
  })
})

describe('fetchDevToEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches and maps articles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([
      { id: 1, title: 'Post', url: 'https://dev.to/user/post', published_at: '2026-01-01T00:00:00Z' },
    ])))
    const events = await fetchDevToEvents({ username: 'user' })
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe('devto:1')
  })

  it('returns [] on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    expect(await fetchDevToEvents({ username: 'ghost' })).toEqual([])
  })

  it('returns [] on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect(await fetchDevToEvents({ username: 'user' })).toEqual([])
  })
})
