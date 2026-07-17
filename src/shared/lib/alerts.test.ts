import { describe, it, expect } from 'vitest'
import { evaluateMatch } from './alerts'

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
