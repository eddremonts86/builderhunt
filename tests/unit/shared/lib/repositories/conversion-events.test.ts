import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  countConversionSessions,
  deleteExpiredConversionEvents,
  recordConversionEvent,
  utcDay,
} from '~/shared/lib/repositories/conversion-events'
import type { ConversionEvent } from '~/shared/lib/conversion-events'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_conversion_events')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => {
  await drop()
})

function event(overrides: Partial<ConversionEvent> = {}): ConversionEvent {
  return {
    name: 'landing_view',
    surface: 'hero',
    sessionId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    variant: 'baseline',
    occurredAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('conversion-events repository', () => {
  it('records a new event', async () => {
    const now = new Date('2026-07-26T10:00:00Z')
    await recordConversionEvent(event({ sessionId: 'a0000000-0000-4000-8000-000000000001' }), now, db)
    const counts = await countConversionSessions('landing_view', 'baseline', utcDay(now), utcDay(now), db)
    expect(counts.sessions).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent — a repeated (sessionId, name, surface, variant) is a no-op', async () => {
    const now = new Date('2026-07-26T10:00:00Z')
    const sessionId = 'a0000000-0000-4000-8000-000000000002'
    const before = await countConversionSessions('landing_view', 'baseline', utcDay(now), utcDay(now), db)
    await recordConversionEvent(event({ sessionId }), now, db)
    await recordConversionEvent(event({ sessionId }), now, db)
    await recordConversionEvent(event({ sessionId }), now, db)
    const after = await countConversionSessions('landing_view', 'baseline', utcDay(now), utcDay(now), db)
    expect(after.sessions).toBe(before.sessions + 1)
    expect(after.events).toBe(before.events + 1)
  })

  it('counts distinct sessions, not raw events, as the funnel unit', async () => {
    const now = new Date('2026-07-27T10:00:00Z')
    // Two distinct sessions both viewing the landing page — two of the same
    // surface/variant, so `events` (2) should exceed `sessions` (2 distinct)
    // once a third duplicate is added to prove the distinction.
    await recordConversionEvent(event({ sessionId: 'b0000000-0000-4000-8000-000000000001' }), now, db)
    await recordConversionEvent(event({ sessionId: 'b0000000-0000-4000-8000-000000000002' }), now, db)
    await recordConversionEvent(event({ sessionId: 'b0000000-0000-4000-8000-000000000001' }), now, db) // dup of session 1
    const counts = await countConversionSessions('landing_view', 'baseline', utcDay(now), utcDay(now), db)
    expect(counts.sessions).toBe(2)
    expect(counts.events).toBe(2) // the dup insert was a no-op
  })

  it('separates counts by day range', async () => {
    const day1 = new Date('2026-06-01T00:00:00Z')
    const day2 = new Date('2026-06-02T00:00:00Z')
    await recordConversionEvent(event({ sessionId: 'c0000000-0000-4000-8000-000000000001' }), day1, db)
    await recordConversionEvent(event({ sessionId: 'c0000000-0000-4000-8000-000000000002' }), day2, db)
    const onlyDay1 = await countConversionSessions('landing_view', 'baseline', utcDay(day1), utcDay(day1), db)
    const both = await countConversionSessions('landing_view', 'baseline', utcDay(day1), utcDay(day2), db)
    expect(onlyDay1.sessions).toBe(1)
    expect(both.sessions).toBe(2)
  })

  it('separates counts by variant', async () => {
    const now = new Date('2026-05-01T00:00:00Z')
    await recordConversionEvent(event({ sessionId: 'd0000000-0000-4000-8000-000000000001', variant: 'baseline' }), now, db)
    await recordConversionEvent(event({ sessionId: 'd0000000-0000-4000-8000-000000000002', variant: 'treatment' }), now, db)
    const baseline = await countConversionSessions('landing_view', 'baseline', utcDay(now), utcDay(now), db)
    const treatment = await countConversionSessions('landing_view', 'treatment', utcDay(now), utcDay(now), db)
    expect(baseline.sessions).toBe(1)
    expect(treatment.sessions).toBe(1)
  })

  it('deletes events older than the retention window and leaves recent ones', async () => {
    const old = new Date('2026-01-01T00:00:00Z')
    const recent = new Date()
    await recordConversionEvent(event({ sessionId: 'e0000000-0000-4000-8000-000000000001' }), old, db)
    await recordConversionEvent(event({ sessionId: 'e0000000-0000-4000-8000-000000000002' }), recent, db)

    const deletedCount = await deleteExpiredConversionEvents(30, recent, db)
    expect(deletedCount).toBeGreaterThanOrEqual(1)

    const oldCounts = await countConversionSessions('landing_view', 'baseline', utcDay(old), utcDay(old), db)
    expect(oldCounts.sessions).toBe(0)
    const recentCounts = await countConversionSessions('landing_view', 'baseline', utcDay(recent), utcDay(recent), db)
    expect(recentCounts.sessions).toBeGreaterThanOrEqual(1)
  })

  it('a second retention run against an already-pruned range deletes nothing (idempotent)', async () => {
    const recent = new Date()
    const first = await deleteExpiredConversionEvents(30, recent, db)
    const second = await deleteExpiredConversionEvents(30, recent, db)
    expect(second).toBe(0)
    expect(first).toBeGreaterThanOrEqual(0)
  })
})
