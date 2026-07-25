import { describe, it, expect } from 'vitest'
import { evaluateMatch, isDueForCheck } from './alerts'

describe('evaluateMatch', () => {
  it('matches any_activity always when no other filters', () => {
    const result = evaluateMatch(
      { eventType: 'any_activity' },
      { followersCount: 0, topics: [] },
      { type: 'new_repo', payload: { name: 'foo' } },
    )
    expect(result).toBe(true)
  })

  it('rejects when event type does not match', () => {
    const result = evaluateMatch(
      { eventType: 'new_repo' },
      {},
      { type: 'new_product', payload: {} },
    )
    expect(result).toBe(false)
  })

  it('rejects when minStars is not met', () => {
    const result = evaluateMatch(
      { eventType: 'any_activity', minStars: 100 },
      { followersCount: 50 },
      { type: 'new_repo', payload: {} },
    )
    expect(result).toBe(false)
  })

  it('accepts when minStars is met', () => {
    const result = evaluateMatch(
      { eventType: 'any_activity', minStars: 100 },
      { followersCount: 150 },
      { type: 'new_repo', payload: {} },
    )
    expect(result).toBe(true)
  })

  it('matches when keyword is in topics', () => {
    const result = evaluateMatch(
      { eventType: 'any_activity', keywords: ['rust', 'async'] },
      { topics: ['Rust', 'WebAssembly'] },
      { type: 'any_activity', payload: {} },
    )
    expect(result).toBe(true)
  })

  it('rejects when no keyword matches', () => {
    const result = evaluateMatch(
      { eventType: 'any_activity', keywords: ['rust', 'async'] },
      { topics: ['JavaScript', 'React'] },
      { type: 'any_activity', payload: {} },
    )
    expect(result).toBe(false)
  })

  it('matches when keyword is in event payload', () => {
    const result = evaluateMatch(
      { eventType: 'new_repo', keywords: ['machine-learning'] },
      {},
      { type: 'new_repo', payload: { description: 'a new machine-learning library' } },
    )
    expect(result).toBe(true)
  })

  it('keyword match is case-insensitive', () => {
    const result = evaluateMatch(
      { eventType: 'any_activity', keywords: ['RUST'] },
      { topics: ['rust'] },
      { type: 'any_activity', payload: {} },
    )
    expect(result).toBe(true)
  })

  it('always matches when watching specific builder', () => {
    const result = evaluateMatch(
      { eventType: 'new_repo', builderId: 'abc123' },
      { followersCount: 0 },
      { type: 'new_repo', payload: {} },
    )
    expect(result).toBe(true)
  })

  it('combines minStars + keyword (all must pass)', () => {
    const result = evaluateMatch(
      { eventType: 'any_activity', minStars: 100, keywords: ['rust'] },
      { followersCount: 200, topics: ['javascript'] },
      { type: 'any_activity', payload: {} },
    )
    expect(result).toBe(false)
  })
})

describe('isDueForCheck', () => {
  const now = new Date('2026-07-25T12:00:00Z')

  it('is always due when never checked', () => {
    expect(isDueForCheck('hourly', null, now)).toBe(true)
    expect(isDueForCheck('daily', null, now)).toBe(true)
    expect(isDueForCheck('weekly', null, now)).toBe(true)
  })

  it('hourly: not due inside the 55-minute window', () => {
    const lastCheckedAt = new Date(now.getTime() - 30 * 60 * 1000)
    expect(isDueForCheck('hourly', lastCheckedAt, now)).toBe(false)
  })

  it('hourly: due once the 55-minute window has passed', () => {
    const lastCheckedAt = new Date(now.getTime() - 56 * 60 * 1000)
    expect(isDueForCheck('hourly', lastCheckedAt, now)).toBe(true)
  })

  it('daily: not due inside the 20-hour window', () => {
    const lastCheckedAt = new Date(now.getTime() - 10 * 60 * 60 * 1000)
    expect(isDueForCheck('daily', lastCheckedAt, now)).toBe(false)
  })

  it('daily: due once the 20-hour window has passed', () => {
    const lastCheckedAt = new Date(now.getTime() - 21 * 60 * 60 * 1000)
    expect(isDueForCheck('daily', lastCheckedAt, now)).toBe(true)
  })

  it('weekly: not due inside the 6.5-day window', () => {
    const lastCheckedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    expect(isDueForCheck('weekly', lastCheckedAt, now)).toBe(false)
  })

  it('weekly: due once the 6.5-day window has passed', () => {
    const lastCheckedAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    expect(isDueForCheck('weekly', lastCheckedAt, now)).toBe(true)
  })

  it('is due exactly at the window boundary', () => {
    const lastCheckedAt = new Date(now.getTime() - 55 * 60 * 1000)
    expect(isDueForCheck('hourly', lastCheckedAt, now)).toBe(true)
  })
})
