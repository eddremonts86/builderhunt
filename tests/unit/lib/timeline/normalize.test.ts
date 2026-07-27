import { describe, expect, it } from 'vitest'
import { normalizeEvents } from '~/lib/timeline/normalize'
import type { TimelineEvent } from '~/lib/timeline/types'

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'github:1',
    type: 'repo',
    source: 'github',
    title: 'Pushed to foo',
    url: 'https://github.com/foo/foo',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('normalizeEvents', () => {
  it('sorts descending by timestamp', () => {
    const result = normalizeEvents([
      event({ id: 'a', timestamp: '2026-01-01T00:00:00Z' }),
      event({ id: 'b', timestamp: '2026-01-03T00:00:00Z' }),
      event({ id: 'c', timestamp: '2026-01-02T00:00:00Z' }),
    ])
    expect(result.map((e) => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('drops events with a future timestamp', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const result = normalizeEvents([event({ id: 'future', timestamp: future }), event({ id: 'now', timestamp: new Date().toISOString() })])
    expect(result.map((e) => e.id)).toEqual(['now'])
  })

  it('drops events older than 365 days', () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const result = normalizeEvents([event({ id: 'old', timestamp: old }), event({ id: 'recent', timestamp: recent })])
    expect(result.map((e) => e.id)).toEqual(['recent'])
  })

  it('dedupes by id, keeping the first occurrence', () => {
    const result = normalizeEvents([
      event({ id: 'dup', title: 'first' }),
      event({ id: 'dup', title: 'second' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('first')
  })

  it('caps at 30 events', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      event({ id: `e${i}`, timestamp: new Date(Date.now() - i * 60_000).toISOString() }))
    expect(normalizeEvents(many)).toHaveLength(30)
  })

  it('truncates descriptions over 280 chars with an ellipsis', () => {
    const long = 'x'.repeat(300)
    const result = normalizeEvents([event({ description: long })])
    expect(result[0].description).toHaveLength(280)
    expect(result[0].description?.endsWith('…')).toBe(true)
  })

  it('leaves short descriptions untouched', () => {
    const result = normalizeEvents([event({ description: 'short' })])
    expect(result[0].description).toBe('short')
  })

  it('drops events with an invalid timestamp', () => {
    expect(normalizeEvents([event({ timestamp: 'not-a-date' })])).toEqual([])
  })
})
