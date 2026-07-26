/**
 * Retention policy for the conversion-event stream (plan: audit-conversion):
 * raw events older than 30 days are deleted. A thin, named policy module —
 * `deleteExpiredConversionEvents` (repositories/conversion-events.ts) does
 * the actual delete — so the retention window is one documented constant
 * callers/tests reference by name rather than a magic number.
 */
import { deleteExpiredConversionEvents } from '~/shared/lib/repositories/conversion-events'

export const CONVERSION_EVENT_RETENTION_DAYS = 30

export interface RetentionRunResult {
  deletedCount: number
  retainDays: number
  ranAt: string
}

export async function runConversionEventRetention(now: Date = new Date()): Promise<RetentionRunResult> {
  const deletedCount = await deleteExpiredConversionEvents(CONVERSION_EVENT_RETENTION_DAYS, now)
  return { deletedCount, retainDays: CONVERSION_EVENT_RETENTION_DAYS, ranAt: now.toISOString() }
}
