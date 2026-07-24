import { describe, expect, it } from 'vitest'
import { evaluateSessionConcurrency, resolveSessionCap, selectSessionToRevoke } from './session-guard'

const CONFIG = { free: 2, pro: 3, teamPerSeat: 2 }

describe('resolveSessionCap', () => {
  it('resolves the free cap', () => {
    expect(resolveSessionCap('free', CONFIG)).toBe(2)
  })

  it('resolves the pro cap', () => {
    expect(resolveSessionCap('pro', CONFIG)).toBe(3)
  })

  it('resolves pro_max to the same cap as pro', () => {
    expect(resolveSessionCap('pro_max', CONFIG)).toBe(3)
  })

  it('resolves the team-per-seat cap', () => {
    expect(resolveSessionCap('team', CONFIG)).toBe(2)
  })

  it('falls back to the free cap for an unrecognized tier', () => {
    expect(resolveSessionCap('unknown', CONFIG)).toBe(2)
  })
})

describe('evaluateSessionConcurrency', () => {
  it('is not over cap at exactly the limit', () => {
    const result = evaluateSessionConcurrency({ tier: 'free', liveSessionCount: 2, config: CONFIG })
    expect(result).toEqual({ cap: 2, overCap: false })
  })

  it('is over cap one session past the limit', () => {
    const result = evaluateSessionConcurrency({ tier: 'free', liveSessionCount: 3, config: CONFIG })
    expect(result).toEqual({ cap: 2, overCap: true })
  })

  it('is not over cap well under the limit', () => {
    const result = evaluateSessionConcurrency({ tier: 'pro', liveSessionCount: 1, config: CONFIG })
    expect(result).toEqual({ cap: 3, overCap: false })
  })

  it('uses the team-per-seat cap for team-tier organizations', () => {
    const result = evaluateSessionConcurrency({ tier: 'team', liveSessionCount: 3, config: CONFIG })
    expect(result).toEqual({ cap: 2, overCap: true })
  })
})

describe('selectSessionToRevoke', () => {
  it('returns null for an empty list', () => {
    expect(selectSessionToRevoke([])).toBeNull()
  })

  it('returns the only session in a single-element list', () => {
    const session = { id: 's1', token: 't1', createdAt: new Date('2026-01-01') }
    expect(selectSessionToRevoke([session])).toEqual(session)
  })

  it('picks the oldest of several sessions regardless of list order', () => {
    const oldest = { id: 's1', token: 't1', createdAt: new Date('2026-01-01') }
    const middle = { id: 's2', token: 't2', createdAt: new Date('2026-01-05') }
    const newest = { id: 's3', token: 't3', createdAt: new Date('2026-01-10') }
    expect(selectSessionToRevoke([middle, newest, oldest])).toEqual(oldest)
    expect(selectSessionToRevoke([oldest, middle, newest])).toEqual(oldest)
    expect(selectSessionToRevoke([newest, oldest, middle])).toEqual(oldest)
  })

  it('breaks a createdAt tie by keeping the first one encountered (stable, not random)', () => {
    const tiedAt = new Date('2026-01-01')
    const first = { id: 's1', token: 't1', createdAt: tiedAt }
    const second = { id: 's2', token: 't2', createdAt: tiedAt }
    expect(selectSessionToRevoke([first, second])).toEqual(first)
  })
})
