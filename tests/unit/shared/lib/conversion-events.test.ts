import { describe, expect, it } from 'vitest'
import { computeConversionRate, isWithinClockSkewWindow, parseConversionEvent } from '~/shared/lib/conversion-events'

const validBase = {
  sessionId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  variant: 'baseline' as const,
  occurredAt: '2026-07-26T10:00:00.000Z',
}

describe('parseConversionEvent', () => {
  it('accepts a valid landing_view event', () => {
    const result = parseConversionEvent({ ...validBase, name: 'landing_view', surface: 'hero' })
    expect(result.ok).toBe(true)
    expect(result.event?.name).toBe('landing_view')
  })

  it('accepts hero_signup_click from either hero or final_cta', () => {
    expect(parseConversionEvent({ ...validBase, name: 'hero_signup_click', surface: 'hero' }).ok).toBe(true)
    expect(parseConversionEvent({ ...validBase, name: 'hero_signup_click', surface: 'final_cta' }).ok).toBe(true)
  })

  it('rejects an unknown event name', () => {
    const result = parseConversionEvent({ ...validBase, name: 'made_up_event', surface: 'hero' })
    expect(result.ok).toBe(false)
  })

  it('rejects a surface not valid for that event name', () => {
    const result = parseConversionEvent({ ...validBase, name: 'explore_search_complete', surface: 'signup' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('cannot occur on surface')
  })

  it('rejects unknown/extra keys (closed schema)', () => {
    const result = parseConversionEvent({ ...validBase, name: 'landing_view', surface: 'hero', query: 'rust developers' })
    expect(result.ok).toBe(false)
  })

  it('rejects a non-UUID sessionId', () => {
    const result = parseConversionEvent({ ...validBase, sessionId: 'not-a-uuid', name: 'landing_view', surface: 'hero' })
    expect(result.ok).toBe(false)
  })

  it('rejects a malformed timestamp', () => {
    const result = parseConversionEvent({ ...validBase, occurredAt: 'yesterday', name: 'landing_view', surface: 'hero' })
    expect(result.ok).toBe(false)
  })

  it('rejects an invalid variant', () => {
    const result = parseConversionEvent({ ...validBase, variant: 'control', name: 'landing_view', surface: 'hero' })
    expect(result.ok).toBe(false)
  })

  it('rejects forbidden PII-shaped fields even if named plausibly', () => {
    const result = parseConversionEvent({ ...validBase, name: 'signup_complete', surface: 'signup', email: 'a@b.com' })
    expect(result.ok).toBe(false)
  })
})

describe('isWithinClockSkewWindow', () => {
  it('accepts a timestamp at the current instant', () => {
    const now = new Date('2026-07-26T10:00:00.000Z')
    expect(isWithinClockSkewWindow('2026-07-26T10:00:00.000Z', now)).toBe(true)
  })

  it('accepts timestamps within 5 minutes in either direction', () => {
    const now = new Date('2026-07-26T10:00:00.000Z')
    expect(isWithinClockSkewWindow('2026-07-26T10:04:59.000Z', now)).toBe(true)
    expect(isWithinClockSkewWindow('2026-07-26T09:55:01.000Z', now)).toBe(true)
  })

  it('rejects a timestamp more than 5 minutes in the future', () => {
    const now = new Date('2026-07-26T10:00:00.000Z')
    expect(isWithinClockSkewWindow('2026-07-26T10:06:00.000Z', now)).toBe(false)
  })

  it('rejects a timestamp more than 5 minutes in the past', () => {
    const now = new Date('2026-07-26T10:00:00.000Z')
    expect(isWithinClockSkewWindow('2026-07-26T09:54:00.000Z', now)).toBe(false)
  })

  it('rejects an unparseable timestamp', () => {
    expect(isWithinClockSkewWindow('not-a-date')).toBe(false)
  })
})

describe('computeConversionRate', () => {
  it('returns null rate/CI for a zero denominator', () => {
    const result = computeConversionRate(0, 0)
    expect(result).toEqual({ numerator: 0, denominator: 0, rate: null, ci95: null, insufficientSample: true })
  })

  it('flags insufficientSample below the minimum-sample threshold, but still reports the raw rate', () => {
    const result = computeConversionRate(2, 10)
    expect(result.insufficientSample).toBe(true)
    expect(result.rate).toBeCloseTo(0.2)
    expect(result.ci95).toBeNull()
  })

  it('computes a Wilson score interval once the sample is large enough', () => {
    const result = computeConversionRate(50, 100)
    expect(result.insufficientSample).toBe(false)
    expect(result.rate).toBeCloseTo(0.5)
    expect(result.ci95).not.toBeNull()
    const [lower, upper] = result.ci95!
    expect(lower).toBeLessThan(0.5)
    expect(upper).toBeGreaterThan(0.5)
    expect(lower).toBeGreaterThanOrEqual(0)
    expect(upper).toBeLessThanOrEqual(1)
  })

  it('keeps the interval within [0, 1] at extreme proportions', () => {
    const allSuccess = computeConversionRate(100, 100)
    expect(allSuccess.ci95![1]).toBeLessThanOrEqual(1)
    const noSuccess = computeConversionRate(0, 100)
    expect(noSuccess.ci95![0]).toBeGreaterThanOrEqual(0)
  })

  it('a wider interval accompanies a smaller (but still sufficient) sample', () => {
    const small = computeConversionRate(15, 30)
    const large = computeConversionRate(500, 1000)
    const smallWidth = small.ci95![1] - small.ci95![0]
    const largeWidth = large.ci95![1] - large.ci95![0]
    expect(smallWidth).toBeGreaterThan(largeWidth)
  })
})
