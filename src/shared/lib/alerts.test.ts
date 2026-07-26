import { describe, it, expect } from 'vitest'
import {
  computeNextEvaluationAt,
  evaluateMatch,
  isDueForCheck,
  isDueForEvaluation,
  nextAlertTimingState,
} from './alerts'

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

// ── Honest evaluation timing (plan: calendar-scheduling-interview-intelligence, Phase 4) ──────

describe('computeNextEvaluationAt', () => {
  const AT = new Date('2027-06-01T12:00:00.000Z')

  it.each([
    ['hourly', 55 * 60 * 1000],
    ['daily', 20 * 60 * 60 * 1000],
    ['weekly', 6.5 * 24 * 60 * 60 * 1000],
  ] as const)('places a successful %s evaluation one window out', (frequency, windowMs) => {
    expect(computeNextEvaluationAt(frequency, AT, 0).getTime()).toBe(AT.getTime() + windowMs)
  })

  it('retries a failed weekly alert in minutes, not a week', () => {
    // The whole point: without backoff, one transient error silences a weekly alert for 7 days.
    const next = computeNextEvaluationAt('weekly', AT, 1)
    expect(next.getTime() - AT.getTime()).toBe(5 * 60 * 1000)
  })

  it('doubles the delay per consecutive failure', () => {
    const delays = [1, 2, 3, 4].map((failures) =>
      computeNextEvaluationAt('weekly', AT, failures).getTime() - AT.getTime())
    expect(delays).toEqual([5, 10, 20, 40].map((minutes) => minutes * 60 * 1000))
  })

  it('never backs off past the frequency window', () => {
    // A persistently broken alert must not check less often than a healthy one — otherwise backoff
    // turns a bug into an indefinite outage.
    const hourlyWindow = 55 * 60 * 1000
    for (const failures of [5, 20, 100]) {
      const delay = computeNextEvaluationAt('hourly', AT, failures).getTime() - AT.getTime()
      expect(delay).toBe(hourlyWindow)
    }
  })

  it('returns a valid date even after an absurd failure count', () => {
    // 2 ** 999 is Infinity; an unclamped exponent would produce an Invalid Date here.
    const next = computeNextEvaluationAt('daily', AT, 1000)
    expect(Number.isNaN(next.getTime())).toBe(false)
  })
})

describe('nextAlertTimingState', () => {
  const AT = new Date('2027-06-01T12:00:00.000Z')

  it('resets the failure count and clears the error code on success', () => {
    const state = nextAlertTimingState('daily', AT, 4, { succeeded: true })
    expect(state).toMatchObject({ consecutiveFailures: 0, lastEvaluationErrorCode: null, lastCheckedAt: AT })
  })

  it('increments the failure count and records a redacted code on failure', () => {
    const state = nextAlertTimingState('daily', AT, 2, { succeeded: false, errorCode: 'rate_limited' })
    expect(state).toMatchObject({ consecutiveFailures: 3, lastEvaluationErrorCode: 'rate_limited' })
  })

  it('never persists a provider message as the error code', () => {
    const state = nextAlertTimingState('daily', AT, 0, {
      succeeded: false,
      errorCode: 'https://api.github.com refused: token ghp_secret',
    })
    expect(state.lastEvaluationErrorCode).toBe('evaluation_failed')
    expect(JSON.stringify(state)).not.toContain('ghp_secret')
  })

  it('moves lastCheckedAt and nextEvaluationAt together', () => {
    // They are returned as one object precisely so the caller writes them in one UPDATE; a split
    // write would let the feed read a next-run derived from the previous attempt.
    const state = nextAlertTimingState('hourly', AT, 0, { succeeded: true })
    expect(state.lastCheckedAt).toBe(AT)
    expect(state.nextEvaluationAt.getTime()).toBeGreaterThan(AT.getTime())
  })
})

describe('isDueForEvaluation', () => {
  const NOW = new Date('2027-06-01T12:00:00.000Z')

  it('honors a persisted next-evaluation time over the frequency window', () => {
    // lastCheckedAt is ancient, so a frequency-only check would say "due". The recorded backoff wins.
    const alert = {
      frequency: 'weekly',
      lastCheckedAt: new Date('2020-01-01T00:00:00.000Z'),
      nextEvaluationAt: new Date('2027-06-01T12:05:00.000Z'),
    }
    expect(isDueForEvaluation(alert, NOW)).toBe(false)
    expect(isDueForEvaluation(alert, new Date('2027-06-01T12:05:00.000Z'))).toBe(true)
  })

  it('falls back to the frequency window for rows that predate the column', () => {
    // No backfill was needed on the migration because of this branch.
    expect(isDueForEvaluation(
      { frequency: 'hourly', lastCheckedAt: new Date('2027-06-01T10:00:00.000Z'), nextEvaluationAt: null },
      NOW,
    )).toBe(true)
    expect(isDueForEvaluation(
      { frequency: 'hourly', lastCheckedAt: new Date('2027-06-01T11:59:00.000Z'), nextEvaluationAt: null },
      NOW,
    )).toBe(false)
  })

  it('treats a never-evaluated alert as due', () => {
    expect(isDueForEvaluation({ frequency: 'weekly', lastCheckedAt: null, nextEvaluationAt: null }, NOW)).toBe(true)
  })
})
