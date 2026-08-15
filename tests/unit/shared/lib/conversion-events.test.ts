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

/**
 * Segmentation events (plan: phase-2/02-segmentacion-usuarios).
 *
 * The stream already refused free text and identity; what these events add is *which* choice
 * somebody made, which is an enum on both ends. The rules worth pinning are the two the schema
 * cannot express on its own: context is required on exactly the events that describe a choice, and
 * forbidden on the ones that do not — a landing event carrying segment context would mean a surface
 * is sending data it has no business holding.
 */
describe('segment events', () => {
  const base = {
    sessionId: '11111111-2222-4333-8444-555555555555',
    variant: 'baseline' as const,
    occurredAt: '2026-08-14T10:00:00.000Z',
  }
  const context = { previous: null, next: 'hiring' as const, source: 'settings' as const }

  it('accepts a selection carrying its context', () => {
    const result = parseConversionEvent({
      ...base, name: 'segment_selected', surface: 'settings', segment: context,
    })
    expect(result.ok).toBe(true)
    expect(result.event?.segment).toEqual(context)
  })

  it('accepts a change from one segment to another, and a clear', () => {
    expect(parseConversionEvent({
      ...base, name: 'segment_changed', surface: 'settings',
      segment: { previous: 'hiring', next: 'investing', source: 'settings' },
    }).ok).toBe(true)

    // Clearing is a real event; `next: null` is the whole point of the field being nullable.
    expect(parseConversionEvent({
      ...base, name: 'segment_changed', surface: 'settings',
      segment: { previous: 'hiring', next: null, source: 'settings' },
    }).ok).toBe(true)
  })

  it('refuses a segment event with no context, because it would be uncountable', () => {
    const result = parseConversionEvent({ ...base, name: 'segment_selected', surface: 'settings' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/requires segment context/)
  })

  it('refuses segment context on an event that is not about a segment', () => {
    const result = parseConversionEvent({ ...base, name: 'landing_view', surface: 'hero', segment: context })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/must not carry segment context/)
  })

  it('refuses anything in the context that is not one of the three allowed fields', () => {
    for (const extra of ['email', 'name', 'query', 'builderId', 'userId']) {
      const result = parseConversionEvent({
        ...base, name: 'segment_selected', surface: 'settings',
        segment: { ...context, [extra]: 'anything' },
      })
      expect(result.ok, `${extra} must be rejected`).toBe(false)
    }
  })

  it('keeps each event on the surfaces it can actually happen on', () => {
    // A skip only exists in a flow that can be skipped.
    expect(parseConversionEvent({
      ...base, name: 'segment_skipped', surface: 'onboarding',
      segment: { previous: null, next: null, source: 'onboarding' },
    }).ok).toBe(true)
    expect(parseConversionEvent({
      ...base, name: 'segment_skipped', surface: 'settings',
      segment: { previous: null, next: null, source: 'settings' },
    }).ok).toBe(false)
    // And no segment event belongs on the landing hero.
    expect(parseConversionEvent({
      ...base, name: 'segment_selected', surface: 'hero', segment: context,
    }).ok).toBe(false)
  })
})

describe('activation', () => {
  const base = {
    sessionId: '11111111-2222-4333-8444-555555555555',
    variant: 'baseline' as const,
    occurredAt: '2026-08-14T10:00:00.000Z',
  }

  it('requires a coarse activation type', () => {
    expect(parseConversionEvent({
      ...base, name: 'activation_reached', surface: 'explore', activationType: 'first_search',
    }).ok).toBe(true)

    const missing = parseConversionEvent({ ...base, name: 'activation_reached', surface: 'explore' })
    expect(missing.ok).toBe(false)
    expect(missing.error).toMatch(/requires activationType/)
  })

  /** An enum, so "which search" can never be what gets recorded. */
  it('refuses an activation type outside the list', () => {
    expect(parseConversionEvent({
      ...base, name: 'activation_reached', surface: 'explore', activationType: 'searched for rust',
    }).ok).toBe(false)
  })

  it('refuses activationType on any other event', () => {
    const result = parseConversionEvent({
      ...base, name: 'landing_view', surface: 'hero', activationType: 'first_search',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/must not carry activationType/)
  })
})
