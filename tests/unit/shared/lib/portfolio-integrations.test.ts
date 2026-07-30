// Plan 37 (portfolio-builder) tasks 1 & 2 — portfolio integrations tests.

import { describe, expect, it } from 'vitest'
import {
  readAiPersonaForPortfolio,
  readTimelineForPortfolio,
} from '~/shared/lib/portfolio-integrations'

const validPersona = {
  summary: 'A senior Rust engineer with deep async-runtime experience and a track record of library maintenance.',
  estimatedSeniority: 'senior' as const,
  primaryFocus: 'systems programming',
  strengths: ['rust', 'async', 'wasm'],
  codingStyle: 'Functional, test-driven, minimal-API crates.',
  enrichedAt: '2026-07-15T12:00:00.000Z',
  model: 'enrich-v1',
  version: 1 as const,
}

describe('readAiPersonaForPortfolio', () => {
  it('returns null when no enrichment is present', () => {
    expect(readAiPersonaForPortfolio(undefined)).toBeNull()
    expect(readAiPersonaForPortfolio(null)).toBeNull()
  })

  it('returns null when the enrichment is shape-invalid', () => {
    expect(readAiPersonaForPortfolio({ summary: 'too short' })).toBeNull()
    expect(readAiPersonaForPortfolio({ ...validPersona, version: 99 })).toBeNull()
    expect(readAiPersonaForPortfolio('not an object')).toBeNull()
    expect(readAiPersonaForPortfolio(42)).toBeNull()
  })

  it('returns the persona when the artifact is shape-valid and fresh', () => {
    const persona = readAiPersonaForPortfolio(validPersona, { now: new Date('2026-07-20T00:00:00.000Z') })
    expect(persona).toBeTruthy()
    expect(persona!.summary).toBe(validPersona.summary)
    expect(persona!.model).toBe('enrich-v1')
  })

  it('returns null when the enrichment is older than the freshness window', () => {
    // Default freshness is 90 days; 2027 is well past.
    const persona = readAiPersonaForPortfolio(validPersona, { now: new Date('2027-01-01T00:00:00.000Z') })
    expect(persona).toBeNull()
  })

  it('returns null when the timestamp is in the future (never trust)', () => {
    const persona = readAiPersonaForPortfolio(
      { ...validPersona, enrichedAt: '2099-01-01T00:00:00.000Z' },
      { now: new Date('2026-07-20T00:00:00.000Z') },
    )
    expect(persona).toBeNull()
  })

  it('returns null when the timestamp is unparseable', () => {
    expect(readAiPersonaForPortfolio({ ...validPersona, enrichedAt: 'not-a-date' })).toBeNull()
  })

  it('returns null when the persona is explicitly disabled by feature flag', () => {
    const persona = readAiPersonaForPortfolio(validPersona, { aiPersonaEnabled: false })
    expect(persona).toBeNull()
  })

  it('honors a custom staleAfterMs (test for ops override)', () => {
    // Same artifact, 5-day window, 30-day-old artifact = stale.
    const persona = readAiPersonaForPortfolio(validPersona, {
      now: new Date('2026-08-01T00:00:00.000Z'),
      staleAfterMs: 5 * 24 * 60 * 60 * 1000,
    })
    expect(persona).toBeNull()
  })
})

describe('readTimelineForPortfolio', () => {
  it('returns [] when no timeline is present', () => {
    expect(readTimelineForPortfolio(undefined)).toEqual([])
    expect(readTimelineForPortfolio(null)).toEqual([])
  })

  it('returns [] when the timeline is not an array', () => {
    expect(readTimelineForPortfolio('not an array')).toEqual([])
    expect(readTimelineForPortfolio({})).toEqual([])
  })

  it('returns [] when the timeline is disabled by feature flag', () => {
    expect(readTimelineForPortfolio([{ id: 'a', occurredAt: '2026-07-01T00:00:00.000Z', kind: 'k', title: 't', summary: 's' }], { timelineEnabled: false })).toEqual([])
  })

  it('filters out shape-invalid events silently', () => {
    const timeline = [
      // Valid:
      { id: 'a', occurredAt: '2026-07-01T00:00:00.000Z', kind: 'ship', title: 'Shipped X', summary: 'Released v1' },
      // Invalid id (too long):
      { id: 'x'.repeat(200), occurredAt: '2026-07-01T00:00:00.000Z', kind: 'ship', title: 'X', summary: 'X' },
      // Invalid timestamp:
      { id: 'b', occurredAt: 'not-a-date', kind: 'ship', title: 'X', summary: 'X' },
      // Missing title:
      { id: 'c', occurredAt: '2026-07-01T00:00:00.000Z', kind: 'ship', title: '', summary: 'X' },
      // Valid:
      { id: 'd', occurredAt: '2026-06-01T00:00:00.000Z', kind: 'release', title: 'Released Y', summary: 'v0.9' },
    ]
    const out = readTimelineForPortfolio(timeline)
    expect(out.map((e) => e.id)).toEqual(['a', 'd'])
  })

  it('honors maxEvents limit', () => {
    const timeline = Array.from({ length: 20 }, (_, i) => ({
      id: `e-${i}`,
      occurredAt: '2026-07-01T00:00:00.000Z',
      kind: 'ship',
      title: `Event ${i}`,
      summary: `Summary ${i}`,
    }))
    expect(readTimelineForPortfolio(timeline, { maxEvents: 3 })).toHaveLength(3)
  })

  it('truncates overly long summaries', () => {
    const longSummary = 'x'.repeat(1000)
    const out = readTimelineForPortfolio([{
      id: 'a', occurredAt: '2026-07-01T00:00:00.000Z', kind: 'k', title: 't', summary: longSummary,
    }])
    expect(out[0].summary.length).toBeLessThanOrEqual(400)
  })

  it('drops events with non-string id (anti-injection)', () => {
    const out = readTimelineForPortfolio([{
      id: 12345, occurredAt: '2026-07-01T00:00:00.000Z', kind: 'k', title: 't', summary: 's',
    }])
    expect(out).toEqual([])
  })
})
