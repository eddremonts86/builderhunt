import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  countConversionSessionsByEvent,
  countOnboardingFunnelSessions,
  deleteExpiredConversionEvents,
  recordConversionEvent,
  utcDay,
} from '~/shared/lib/repositories/conversion-events'
import type { ConversionEvent } from '~/shared/lib/conversion-events'

/**
 * One event's counts, through the batched reader.
 *
 * The single-event `countConversionSessions` these cases were written against is gone: the route now issues
 * one grouped query for every funnel event, so a per-event function was production-dead code kept alive only
 * by this file. Asking for a list of one keeps every case below testing the query that actually runs.
 */
async function countOne(name: string, variant: 'baseline' | 'treatment', startDay: string, endDay: string) {
  const counts = await countConversionSessionsByEvent([name], variant, startDay, endDay, db)
  return counts.get(name)!
}

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
    const counts = await countOne('landing_view', 'baseline', utcDay(now), utcDay(now))
    expect(counts.sessions).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent — a repeated (sessionId, name, surface, variant) is a no-op', async () => {
    const now = new Date('2026-07-26T10:00:00Z')
    const sessionId = 'a0000000-0000-4000-8000-000000000002'
    const before = await countOne('landing_view', 'baseline', utcDay(now), utcDay(now))
    await recordConversionEvent(event({ sessionId }), now, db)
    await recordConversionEvent(event({ sessionId }), now, db)
    await recordConversionEvent(event({ sessionId }), now, db)
    const after = await countOne('landing_view', 'baseline', utcDay(now), utcDay(now))
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
    const counts = await countOne('landing_view', 'baseline', utcDay(now), utcDay(now))
    expect(counts.sessions).toBe(2)
    expect(counts.events).toBe(2) // the dup insert was a no-op
  })

  it('separates counts by day range', async () => {
    const day1 = new Date('2026-06-01T00:00:00Z')
    const day2 = new Date('2026-06-02T00:00:00Z')
    await recordConversionEvent(event({ sessionId: 'c0000000-0000-4000-8000-000000000001' }), day1, db)
    await recordConversionEvent(event({ sessionId: 'c0000000-0000-4000-8000-000000000002' }), day2, db)
    const onlyDay1 = await countOne('landing_view', 'baseline', utcDay(day1), utcDay(day1))
    const both = await countOne('landing_view', 'baseline', utcDay(day1), utcDay(day2))
    expect(onlyDay1.sessions).toBe(1)
    expect(both.sessions).toBe(2)
  })

  it('separates counts by variant', async () => {
    const now = new Date('2026-05-01T00:00:00Z')
    await recordConversionEvent(event({ sessionId: 'd0000000-0000-4000-8000-000000000001', variant: 'baseline' }), now, db)
    await recordConversionEvent(event({ sessionId: 'd0000000-0000-4000-8000-000000000002', variant: 'treatment' }), now, db)
    const baseline = await countOne('landing_view', 'baseline', utcDay(now), utcDay(now))
    const treatment = await countOne('landing_view', 'treatment', utcDay(now), utcDay(now))
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

    const oldCounts = await countOne('landing_view', 'baseline', utcDay(old), utcDay(old))
    expect(oldCounts.sessions).toBe(0)
    const recentCounts = await countOne('landing_view', 'baseline', utcDay(recent), utcDay(recent))
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

describe('the batched reader (plan 57, "query count stays constant as metric definitions grow")', () => {
  it('counts every requested event in one query, keyed by name', async () => {
    const now = new Date('2026-04-01T00:00:00Z')
    await recordConversionEvent(event({ name: 'landing_view', sessionId: 'f0000000-0000-4000-8000-000000000001' }), now, db)
    await recordConversionEvent(event({ name: 'signup_submit', surface: 'signup', sessionId: 'f0000000-0000-4000-8000-000000000001' }), now, db)
    await recordConversionEvent(event({ name: 'signup_submit', surface: 'signup', sessionId: 'f0000000-0000-4000-8000-000000000002' }), now, db)

    const counts = await countConversionSessionsByEvent(
      ['landing_view', 'signup_submit'],
      'baseline',
      utcDay(now),
      utcDay(now),
      db,
    )
    expect(counts.get('landing_view')?.sessions).toBe(1)
    expect(counts.get('signup_submit')?.sessions).toBe(2)
  })

  it('returns a zero entry for a requested event with no sessions, rather than no entry', async () => {
    /**
     * An absent key is indistinguishable from a zero to a caller doing `counts.get(name)?.sessions ?? 0`, and
     * the difference matters in the other direction: a metric whose denominator event was never emitted must
     * come out as an undefined rate, not silently vanish from the funnel table.
     */
    const now = new Date('2026-04-02T00:00:00Z')
    const counts = await countConversionSessionsByEvent(
      ['landing_view', 'an_event_nobody_emitted'],
      'baseline',
      utcDay(now),
      utcDay(now),
      db,
    )
    expect(counts.has('an_event_nobody_emitted')).toBe(true)
    expect(counts.get('an_event_nobody_emitted')).toEqual({ sessions: 0, events: 0 })
  })

  it('reads only the names it was given, so the data cannot decide the result size', async () => {
    // `select distinct name` would let a bug that wrote arbitrary names turn this into an unbounded read.
    const now = new Date('2026-04-03T00:00:00Z')
    await recordConversionEvent(event({ name: 'landing_view', sessionId: 'f0000000-0000-4000-8000-000000000003' }), now, db)
    await recordConversionEvent(event({ name: 'hero_signup_click', surface: 'hero', sessionId: 'f0000000-0000-4000-8000-000000000003' }), now, db)

    const counts = await countConversionSessionsByEvent(['landing_view'], 'baseline', utcDay(now), utcDay(now), db)
    expect([...counts.keys()]).toEqual(['landing_view'])
  })

  it('still separates variants and day ranges', async () => {
    const day1 = new Date('2026-03-01T00:00:00Z')
    const day2 = new Date('2026-03-02T00:00:00Z')
    await recordConversionEvent(event({ sessionId: 'f1000000-0000-4000-8000-000000000001', variant: 'baseline' }), day1, db)
    await recordConversionEvent(event({ sessionId: 'f1000000-0000-4000-8000-000000000002', variant: 'treatment' }), day2, db)

    const baselineDay1 = await countConversionSessionsByEvent(['landing_view'], 'baseline', utcDay(day1), utcDay(day1), db)
    const treatmentBoth = await countConversionSessionsByEvent(['landing_view'], 'treatment', utcDay(day1), utcDay(day2), db)
    expect(baselineDay1.get('landing_view')?.sessions).toBe(1)
    expect(treatmentBoth.get('landing_view')?.sessions).toBe(1)
  })

  it('asks the database nothing at all for an empty name list', async () => {
    const counts = await countConversionSessionsByEvent([], 'baseline', '2026-01-01', '2026-01-02', db)
    expect(counts.size).toBe(0)
  })
})

describe('the funnel definitions cost one query, whatever their number', () => {
  it('issues exactly one statement for every metric the route defines', async () => {
    /**
     * The Verify line this closes: "query count stays constant as metric definitions grow".
     *
     * The route used to await a pair of counts per definition — twelve sequential round trips for six metrics,
     * growing by two with each one added. Counted here by wrapping the connection rather than by timing,
     * because a latency budget passes on a fast machine with a linear query count and only fails once somebody
     * adds the metric that tips it over.
     */
    const now = new Date('2026-02-01T00:00:00Z')
    // The six real definitions reference eight distinct events; `landing_view` is the denominator of three.
    const eventNames = [
      'signup_complete',
      'landing_view',
      'hero_signup_click',
      'hero_explore_click',
      'explore_search_complete',
      'explore_signup_click',
      'signup_submit',
    ]

    let statements = 0
    const counting = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'select') {
          statements += 1
        }
        return Reflect.get(target, property, receiver)
      },
    }) as typeof db

    await countConversionSessionsByEvent(eventNames, 'baseline', utcDay(now), utcDay(now), counting)
    expect(statements).toBe(1)

    // And doubling the definition list does not double the statements.
    statements = 0
    await countConversionSessionsByEvent([...eventNames, ...eventNames.map((n) => `${n}_v2`)], 'baseline', utcDay(now), utcDay(now), counting)
    expect(statements).toBe(1)
  })
})

/**
 * The dimensions actually land in the table (plan: phase-2/03-onboarding-segmentado).
 *
 * This is the half that was missing rather than wrong. `recordConversionEvent` inserted six columns
 * and discarded everything else the validated event carried, so the segment context plan 02 added
 * passed validation, reached the repository and vanished — and the table's CHECK constraint refused
 * the event names outright, which the ingest route logs and answers `{ ok: true }` to. A funnel that
 * cannot be computed from the rows is not instrumentation.
 */
describe('the funnel dimensions', () => {
  const onboarding = { flowVersion: 2 as const, preset: 'hiring' as const, stepKey: 'hiring_search' as const }

  it('accepts the segment and onboarding event names the database used to refuse', async () => {
    await recordConversionEvent(event({
      name: 'segment_selected', surface: 'onboarding', sessionId: 'dim-1',
      segment: { previous: null, next: 'hiring', source: 'onboarding' },
    }), new Date('2026-08-15T10:00:00Z'), db)

    await recordConversionEvent(event({
      name: 'onboarding_step_viewed', surface: 'onboarding', sessionId: 'dim-1', onboarding,
    }), new Date('2026-08-15T10:00:00Z'), db)

    const rows = await countOnboardingFunnelSessions('baseline', '2026-08-15', '2026-08-15', db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'onboarding_step_viewed', flowVersion: 2, preset: 'hiring', stepKey: 'hiring_search', sessions: 1,
    })
  })

  /**
   * The identity index carries the step key, so the second step in a session is a new row. Without
   * it, `onConflictDoNothing` swallowed every step after the first and the funnel could only ever
   * have shown step one.
   */
  it('does not collapse two different steps in one session', async () => {
    for (const stepKey of ['welcome', 'goal', 'hiring_search'] as const) {
      await recordConversionEvent(event({
        name: 'onboarding_step_viewed', surface: 'onboarding', sessionId: 'dim-2',
        onboarding: { flowVersion: 2, preset: 'hiring', stepKey },
      }), new Date('2026-08-16T10:00:00Z'), db)
    }

    const rows = await countOnboardingFunnelSessions('baseline', '2026-08-16', '2026-08-16', db)
    expect(rows.map((row) => row.stepKey).sort()).toEqual(['goal', 'hiring_search', 'welcome'])
  })

  /** The same step twice in one session is still a retry, and still a no-op. */
  it('still collapses a genuine retry', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordConversionEvent(event({
        name: 'onboarding_step_completed', surface: 'onboarding', sessionId: 'dim-3', onboarding,
      }), new Date('2026-08-17T10:00:00Z'), db)
    }

    const rows = await countOnboardingFunnelSessions('baseline', '2026-08-17', '2026-08-17', db)
    expect(rows).toHaveLength(1)
    expect(rows[0].events).toBe(1)
  })

  /** Split by version, because that is the question a cohort ramp asks. */
  it('separates the two flow versions', async () => {
    for (const [session, flowVersion] of [['dim-4', 1], ['dim-5', 2]] as const) {
      await recordConversionEvent(event({
        name: 'onboarding_step_viewed', surface: 'onboarding', sessionId: session,
        onboarding: { flowVersion, preset: 'general', stepKey: 'welcome' },
      }), new Date('2026-08-18T10:00:00Z'), db)
    }

    const rows = await countOnboardingFunnelSessions('baseline', '2026-08-18', '2026-08-18', db)
    expect(rows.map((row) => row.flowVersion).sort()).toEqual([1, 2])
  })
})
