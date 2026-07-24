import { describe, expect, it } from 'vitest'
import { evaluateSessionConcurrency, resolveSessionCap } from './session-guard'

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
