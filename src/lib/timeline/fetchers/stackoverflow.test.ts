import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchStackOverflowEvents, mapSOAnswer } from './stackoverflow'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('mapSOAnswer', () => {
  it('maps an answer with a title', () => {
    const result = mapSOAnswer({ answer_id: 42, question_id: 1, creation_date: 1_700_000_000, title: 'How do I X?', body: '<p>Do <b>this</b></p>' })
    expect(result).toEqual({
      id: 'stackoverflow:42',
      type: 'answer',
      source: 'stackoverflow',
      title: 'Answered: How do I X?',
      description: 'Do this',
      url: 'https://stackoverflow.com/a/42',
      timestamp: new Date(1_700_000_000 * 1000).toISOString(),
    })
  })

  it('falls back to a generic title when the filter did not provide one', () => {
    const result = mapSOAnswer({ answer_id: 43, question_id: 2, creation_date: 1_700_000_000 })
    expect(result.title).toBe('Answered a question')
    expect(result.description).toBeUndefined()
  })
})

describe('fetchStackOverflowEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches and maps answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      items: [{ answer_id: 1, question_id: 1, creation_date: 1_700_000_000 }],
    })))
    const events = await fetchStackOverflowEvents({ sourceId: '12345' })
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe('stackoverflow:1')
  })

  it('returns [] on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 400)))
    expect(await fetchStackOverflowEvents({ sourceId: '12345' })).toEqual([])
  })

  it('returns [] on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect(await fetchStackOverflowEvents({ sourceId: '12345' })).toEqual([])
  })
})
