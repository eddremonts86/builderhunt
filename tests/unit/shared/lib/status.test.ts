import { describe, it, expect } from 'vitest'
import { aggregateStatus, formatDuration, computeDuration, computeUptime } from '~/shared/lib/status'

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

describe('computeUptime', () => {
  function checksSpanningDays(days: number, intervalMinutes: number, downCount = 0): Array<{ checkedAt: Date; ok: boolean }> {
    const totalSamples = Math.round((days * 24 * 60) / intervalMinutes)
    const now = Date.now()
    return Array.from({ length: totalSamples }, (_, i) => ({
      checkedAt: new Date(now - i * intervalMinutes * 60 * 1000),
      ok: i >= downCount, // the most recent `downCount` samples are down
    }))
  }

  it('returns null when there is no data at all', () => {
    expect(computeUptime([], 30)).toBeNull()
  })

  it('returns null when under a day of history exists, even with 100% ok samples', () => {
    const checks = checksSpanningDays(0.5, 5)
    expect(computeUptime(checks, 30)).toBeNull()
  })

  it('returns 100 when every expected sample over the window is ok', () => {
    const checks = checksSpanningDays(30, 5)
    expect(computeUptime(checks, 30)).toBe(100)
  })

  it('is proportional to a one-hour gap of down samples', () => {
    // 30 days at 5-minute intervals = 8640 expected samples; 12 down samples = 1 hour.
    const checks = checksSpanningDays(30, 5, 12)
    const uptime = computeUptime(checks, 30)!
    expect(uptime).toBeCloseTo(((8640 - 12) / 8640) * 100, 5)
  })

  it('treats missing samples (gaps) as down, not as absent data', () => {
    // Only half the expected samples exist (cron only ran for the back half of the window) — all present ones ok.
    const checks = checksSpanningDays(30, 5).slice(0, 4320)
    const uptime = computeUptime(checks, 30)!
    expect(uptime).toBeCloseTo(50, 0)
  })

  it('never exceeds 100 even if more ok samples exist than theoretically expected', () => {
    const checks = checksSpanningDays(30, 5)
    // Duplicate every sample (e.g. the cron ran twice in one interval) — should still cap at 100.
    const doubled = [...checks, ...checks]
    expect(computeUptime(doubled, 30)).toBe(100)
  })
})
