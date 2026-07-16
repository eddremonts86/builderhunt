import { describe, it, expect } from 'vitest'
import { aggregateStatus, formatDuration, computeDuration } from './status'

describe('aggregateStatus', () => {
  it('returns operational when all components are operational', () => {
    const result = aggregateStatus([
      { name: 'App', status: 'operational' },
      { name: 'DB', status: 'operational' },
    ])
    expect(result.status).toBe('operational')
    expect(result.components).toHaveLength(2)
  })

  it('returns degraded when any component is degraded', () => {
    const result = aggregateStatus([
      { name: 'App', status: 'operational' },
      { name: 'Search', status: 'degraded', message: 'slow' },
    ])
    expect(result.status).toBe('degraded')
  })

  it('returns outage if any component is down (overrides degraded)', () => {
    const result = aggregateStatus([
      { name: 'App', status: 'degraded' },
      { name: 'DB', status: 'outage' },
    ])
    expect(result.status).toBe('outage')
  })

  it('handles empty components', () => {
    expect(aggregateStatus([]).status).toBe('operational')
  })
})

describe('formatDuration', () => {
  it('formats minutes', () => {
    expect(formatDuration(45)).toBe('45m')
  })
  it('formats hours + minutes', () => {
    expect(formatDuration(125)).toBe('2h 5m')
  })
  it('formats days + hours', () => {
    expect(formatDuration(60 * 25)).toBe('1d 1h')
  })
  it('handles null', () => {
    expect(formatDuration(null)).toBe('—')
  })
  it('handles 0', () => {
    expect(formatDuration(0)).toBe('0m')
  })
})

describe('computeDuration', () => {
  it('returns null when not resolved', () => {
    const start = new Date().toISOString()
    expect(computeDuration(start, null)).toBeNull()
  })
  it('computes minutes between two timestamps', () => {
    const start = '2026-01-01T10:00:00.000Z'
    const end = '2026-01-01T11:30:00.000Z'
    expect(computeDuration(start, end)).toBe(90)
  })
})
