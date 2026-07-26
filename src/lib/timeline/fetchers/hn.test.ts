import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHNEvents, mapAlgoliaHit } from './hn'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('mapAlgoliaHit', () => {
  it('maps a story hit to a post event', () => {
    const result = mapAlgoliaHit({
      objectID: '111',
      author: 'pg',
      title: 'Show HN: my thing',
      url: 'https://example.com/thing',
      created_at: '2026-01-01T00:00:00Z',
      _tags: ['story', 'author_pg'],
    })
    expect(result).toEqual({
      id: 'hn:111',
      type: 'post',
      source: 'hn',
      title: 'Show HN: my thing',
      description: undefined,
      url: 'https://example.com/thing',
      timestamp: '2026-01-01T00:00:00Z',
    })
  })

  it('falls back to the HN item URL when a story has no external url', () => {
    const result = mapAlgoliaHit({ objectID: '111', author: 'pg', title: 'Ask HN: question', created_at: '2026-01-01T00:00:00Z' })
    expect(result?.url).toBe('https://news.ycombinator.com/item?id=111')
  })

  it('maps a comment hit and strips HTML', () => {
    const result = mapAlgoliaHit({
      objectID: '222',
      author: 'pg',
      comment_text: '<p>Great point &#x2F; totally agree</p>',
      story_title: 'Original story',
      created_at: '2026-01-02T00:00:00Z',
      _tags: ['comment', 'author_pg'],
    })
    expect(result?.type).toBe('comment')
    expect(result?.description).toBe('Great point / totally agree')
    expect(result?.title).toBe('Commented on: Original story')
  })

  it('returns null for a comment hit with empty text', () => {
    expect(mapAlgoliaHit({ objectID: '222', author: 'pg', comment_text: '', created_at: '2026-01-02T00:00:00Z', _tags: ['comment'] })).toBeNull()
  })

  it('returns null for a story hit with no title', () => {
    expect(mapAlgoliaHit({ objectID: '333', author: 'pg', created_at: '2026-01-03T00:00:00Z', _tags: ['story'] })).toBeNull()
  })
})

describe('fetchHNEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches and maps hits', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      hits: [{ objectID: '1', author: 'pg', title: 'Story', created_at: '2026-01-01T00:00:00Z', _tags: ['story'] }],
    })))
    const events = await fetchHNEvents({ username: 'pg' })
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe('hn:1')
  })

  it('returns [] on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 503)))
    expect(await fetchHNEvents({ username: 'pg' })).toEqual([])
  })

  it('returns [] on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    expect(await fetchHNEvents({ username: 'pg' })).toEqual([])
  })
})
