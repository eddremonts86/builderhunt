import { describe, expect, it, vi } from 'vitest'

vi.mock('~/shared/lib/repositories/conversion-events', () => ({
  deleteExpiredConversionEvents: vi.fn().mockResolvedValue(7),
}))

const { deleteExpiredConversionEvents } = await import('~/shared/lib/repositories/conversion-events')
const { CONVERSION_EVENT_RETENTION_DAYS, runConversionEventRetention } = await import('~/shared/lib/conversion-retention')

describe('runConversionEventRetention', () => {
  it('delegates to deleteExpiredConversionEvents with the documented retention window', async () => {
    const now = new Date('2026-07-26T00:00:00Z')
    const result = await runConversionEventRetention(now)
    expect(deleteExpiredConversionEvents).toHaveBeenCalledWith(CONVERSION_EVENT_RETENTION_DAYS, now)
    expect(result).toEqual({ deletedCount: 7, retainDays: 30, ranAt: now.toISOString() })
  })

  it('retention window is exactly 30 days', () => {
    expect(CONVERSION_EVENT_RETENTION_DAYS).toBe(30)
  })
})
